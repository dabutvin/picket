import { describe, expect, it, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { createMemoryConnectionStore } from '../src/connection.js';
import { createUploader, toAdobeDate, type UploaderDeps } from '../src/uploader.js';
import type { LightroomInfo, PhotoItem } from '../src/types.js';
import { connection, fakeFetch, item, lrJson } from './helpers.js';

const sqs = (...ids: string[]): SQSEvent =>
  ({ Records: ids.map((id, i) => ({ messageId: `m${i}`, body: JSON.stringify({ photoId: id }) })) }) as unknown as SQSEvent;

function photoStore(initial: PhotoItem[]) {
  const rows = new Map(initial.map((p) => [p.photoId, p]));
  return {
    rows,
    get: vi.fn(async (id: string) => rows.get(id)),
    setLightroom: vi.fn(async (id: string, info: LightroomInfo) => {
      const p = rows.get(id);
      if (!p) return undefined;
      const next = { ...p, lightroomStatus: info.status, lightroom: info };
      rows.set(id, next);
      return next;
    }),
  };
}

const happyFetch = () =>
  fakeFetch({
    'GET /v2/catalogs/cat1/albums?subtype=project': () => lrJson({ resources: [] }),
    'PUT /v2/catalogs/cat1/albums/': (_init, url) =>
      url!.endsWith('/assets') ? new Response(null, { status: 201 }) : new Response(null, { status: 201 }),
    'PUT /v2/catalogs/cat1/assets/': () => new Response(null, { status: 201 }),
  });

const make = (over: Partial<UploaderDeps> = {}) => {
  const store = photoStore([item('a', 'pick', { lightroomStatus: 'queued' }), item('r', 'reject')]);
  const connections = createMemoryConnectionStore(connection());
  const { fn, calls } = happyFetch();
  const deps: UploaderDeps = {
    store,
    connections,
    getRaw: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    clientId: 'cid',
    albumName: 'Picket',
    fetchFn: fn,
    ...over,
  };
  return { store, connections, calls, handle: createUploader(deps) };
};

describe('uploader', () => {
  it('creates the album once, creates the asset, uploads the master, adds to album, marks done', async () => {
    const { store, connections, calls, handle } = make();
    const r = await handle(sqs('a'));
    expect(r.batchItemFailures).toEqual([]);
    const row = store.rows.get('a')!;
    expect(row.lightroom).toMatchObject({ status: 'done', attempts: 1 });
    expect(row.lightroom!.assetId).toMatch(/^[0-9a-f]{32}$/);
    const conn = await connections.load();
    expect(conn!.albumId).toMatch(/^[0-9a-f]{32}$/);
    expect(row.lightroom!.albumId).toBe(conn!.albumId);

    const seq = calls.map((c) => `${c.method} ${c.url.replace('https://lr.adobe.io', '')}`);
    expect(seq[0]).toBe('GET /v2/catalogs/cat1/albums?subtype=project');
    expect(seq[1]).toBe(`PUT /v2/catalogs/cat1/albums/${conn!.albumId}`);
    expect(seq[2]).toBe(`PUT /v2/catalogs/cat1/assets/${row.lightroom!.assetId}`);
    expect(seq[3]).toBe(`PUT /v2/catalogs/cat1/assets/${row.lightroom!.assetId}/master`);
    expect(seq[4]).toBe(`PUT /v2/catalogs/cat1/albums/${conn!.albumId}/assets`);
    const create = JSON.parse(calls[2]!.init!.body as string);
    expect(create.payload.importSource.sha256).toBe('9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a');
    expect(create.payload.importSource.fileSize).toBe(4);
    expect(create.payload.captureDate).toBe('2026-10-30T10:00:00');
    expect((calls[3]!.init!.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
    const add = JSON.parse(calls[4]!.init!.body as string);
    expect(add.resources[0].payload.publishInfo.remoteId).toBe('a');
  });

  it('skips photos that are no longer picks, already done, or missing', async () => {
    const { store, calls, handle } = make();
    store.rows.set('d', item('d', 'pick', { lightroom: { status: 'done', updatedAt: 'x', assetId: 'z' } }));
    await handle(sqs('r', 'd', 'nope'));
    expect(calls).toHaveLength(0);
    expect(store.setLightroom).not.toHaveBeenCalled();
  });

  it('marks failed without retry when Lightroom is not connected', async () => {
    const { store, handle } = make({ connections: createMemoryConnectionStore(null) });
    const r = await handle(sqs('a'));
    expect(r.batchItemFailures).toEqual([]);
    expect(store.rows.get('a')!.lightroom).toMatchObject({ status: 'failed', error: 'Lightroom is not connected' });
  });

  it('records duplicates without uploading', async () => {
    const { fn, calls } = fakeFetch({
      'GET /v2/catalogs/cat1/albums?subtype=project': () => lrJson({ resources: [{ id: 'alb1', payload: { name: 'Picket' } }] }),
      'PUT /v2/catalogs/cat1/assets/': () => new Response(null, { status: 412 }),
    });
    const { store, handle } = make({ fetchFn: fn });
    await handle(sqs('a'));
    expect(store.rows.get('a')!.lightroom).toMatchObject({ status: 'duplicate', albumId: 'alb1' });
    expect(calls.some((c) => c.url.endsWith('/master'))).toBe(false);
  });

  it('returns the message for retry on transient errors and not on permanent ones', async () => {
    let attempt = 0;
    const flaky = fakeFetch({
      'GET /v2/catalogs/cat1/albums?subtype=project': () => lrJson({ resources: [{ id: 'alb1', payload: { name: 'Picket' } }] }),
      'PUT /v2/catalogs/cat1/assets/': (_init, url) => {
        if (url!.endsWith('/master')) return new Response('', { status: ++attempt === 1 ? 429 : 413 });
        return new Response(null, { status: 201 });
      },
    });
    const { store, handle } = make({ fetchFn: flaky.fn });
    let r = await handle(sqs('a'));
    expect(r.batchItemFailures).toEqual([{ itemIdentifier: 'm0' }]);
    expect(store.rows.get('a')!.lightroom).toMatchObject({ status: 'failed', attempts: 1 });
    const assetId = store.rows.get('a')!.lightroom!.assetId;
    r = await handle(sqs('a'));
    expect(r.batchItemFailures).toEqual([]); // 413 storage full: give up
    expect(store.rows.get('a')!.lightroom).toMatchObject({ status: 'failed', attempts: 2 });
    expect(store.rows.get('a')!.lightroom!.assetId).toBe(assetId); // same asset id reused across retries
  });

  it('reuses an existing Picket album', async () => {
    const { fn, calls } = fakeFetch({
      'GET /v2/catalogs/cat1/albums?subtype=project': () => lrJson({ resources: [{ id: 'alb9', payload: { name: 'Picket' } }] }),
      'PUT /v2/catalogs/cat1/': () => new Response(null, { status: 201 }),
    });
    const { connections, handle } = make({ fetchFn: fn });
    await handle(sqs('a'));
    expect((await connections.load())!.albumId).toBe('alb9');
    expect(calls.filter((c) => c.method === 'PUT' && /albums\/alb9$/.test(c.url))).toHaveLength(0);
  });
});

describe('toAdobeDate', () => {
  it('passes camera-local timestamps through and normalizes zoned ones', () => {
    expect(toAdobeDate('2026-10-30T10:00:00')).toBe('2026-10-30T10:00:00');
    expect(toAdobeDate('2026-10-30T10:00:00.123Z')).toBe('2026-10-30T10:00:00Z');
  });
});
