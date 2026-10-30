import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createApp } from '../src/app.js';
import { BadCursor, decodeCursor, encodeCursor, type Store } from '../src/store.js';
import type { PhotoItem } from '../src/types.js';

const item = (id: string, status: PhotoItem['status'] = 'unreviewed'): PhotoItem => ({
  photoId: id,
  status,
  capturedAt: '2026-10-30T10:00:00',
  uploadedAt: '2026-10-30T10:01:00Z',
  rawKey: `raw/2026/10/30/${id}.ARW`,
  fileName: `${id}.ARW`,
  previewKey: `previews/${id}.jpg`,
  thumbKey: `thumbs/${id}.jpg`,
  bytes: 123,
});

const fakeStore = (): Store => ({
  listByStatus: vi.fn(async (status, limit, cursor) => {
    if (cursor === 'bad') throw new BadCursor();
    return { items: [item('a', status), item('b', status)].slice(0, limit), cursor: limit < 2 ? 'next' : undefined };
  }),
  get: vi.fn(async (id) => (id === 'a' ? item('a') : undefined)),
  setStatus: vi.fn(async (id, status) => (id === 'a' ? item('a', status) : undefined)),
  signGet: vi.fn(async (key, ttl, downloadAs) => `https://s3/${key}?ttl=${ttl}${downloadAs ? `&dl=${downloadAs}` : ''}`),
});

const ev = (routeKey: string, extra: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 =>
  ({ routeKey, rawPath: '/', headers: {}, requestContext: {} as never, isBase64Encoded: false, ...extra }) as APIGatewayProxyEventV2;

const body = (r: Awaited<ReturnType<ReturnType<typeof createApp>>>) => JSON.parse(r.body ?? 'null');

describe('GET /photos', () => {
  it('defaults to unreviewed and attaches presigned urls', async () => {
    const store = fakeStore();
    const r = await createApp(store)(ev('GET /photos'));
    expect(r.statusCode).toBe(200);
    expect(store.listByStatus).toHaveBeenCalledWith('unreviewed', 30, undefined);
    const b = body(r);
    expect(b.items).toHaveLength(2);
    expect(b.items[0].previewUrl).toBe('https://s3/previews/a.jpg?ttl=3600');
    expect(b.items[0].thumbUrl).toBe('https://s3/thumbs/a.jpg?ttl=3600');
    expect(b.cursor).toBeUndefined();
  });

  it('passes status, clamps limit, returns cursor', async () => {
    const store = fakeStore();
    const r = await createApp(store)(ev('GET /photos', { queryStringParameters: { status: 'pick', limit: '1' } }));
    expect(store.listByStatus).toHaveBeenCalledWith('pick', 1, undefined);
    expect(body(r).cursor).toBe('next');
    await createApp(store)(ev('GET /photos', { queryStringParameters: { limit: '5000' } }));
    expect(store.listByStatus).toHaveBeenLastCalledWith('unreviewed', 100, undefined);
  });

  it('rejects bad status, limit and cursor', async () => {
    const app = createApp(fakeStore());
    expect((await app(ev('GET /photos', { queryStringParameters: { status: 'maybe' } }))).statusCode).toBe(400);
    expect((await app(ev('GET /photos', { queryStringParameters: { limit: '0' } }))).statusCode).toBe(400);
    expect((await app(ev('GET /photos', { queryStringParameters: { cursor: 'bad' } }))).statusCode).toBe(400);
  });
});

describe('POST /photos/{id}/decision', () => {
  it('updates and returns the photo', async () => {
    const store = fakeStore();
    const r = await createApp(store)(
      ev('POST /photos/{id}/decision', { pathParameters: { id: 'a' }, body: JSON.stringify({ decision: 'pick' }) }),
    );
    expect(r.statusCode).toBe(200);
    expect(store.setStatus).toHaveBeenCalledWith('a', 'pick');
    expect(body(r).status).toBe('pick');
  });

  it('404s on unknown photo, 400s on bad body', async () => {
    const app = createApp(fakeStore());
    expect((await app(ev('POST /photos/{id}/decision', { pathParameters: { id: 'zz' }, body: '{"decision":"pick"}' }))).statusCode).toBe(404);
    expect((await app(ev('POST /photos/{id}/decision', { pathParameters: { id: 'a' }, body: '{"decision":"meh"}' }))).statusCode).toBe(400);
    expect((await app(ev('POST /photos/{id}/decision', { pathParameters: { id: 'a' }, body: 'not json' }))).statusCode).toBe(400);
  });
});

describe('GET /photos/{id}/raw-url', () => {
  it('returns a short-lived download url with the original filename', async () => {
    const r = await createApp(fakeStore())(ev('GET /photos/{id}/raw-url', { pathParameters: { id: 'a' } }));
    expect(r.statusCode).toBe(200);
    expect(body(r)).toEqual({ url: 'https://s3/raw/2026/10/30/a.ARW?ttl=900&dl=a.ARW', fileName: 'a.ARW', bytes: 123, expiresInSeconds: 900 });
  });
  it('404s on unknown photo', async () => {
    expect((await createApp(fakeStore())(ev('GET /photos/{id}/raw-url', { pathParameters: { id: 'zz' } }))).statusCode).toBe(404);
  });
});

describe('routing', () => {
  it('404s unknown routes and 500s on store failure', async () => {
    const store = fakeStore();
    (store.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const app = createApp(store);
    expect((await app(ev('DELETE /photos'))).statusCode).toBe(404);
    expect((await app(ev('GET /photos/{id}/raw-url', { pathParameters: { id: 'a' } }))).statusCode).toBe(500);
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    const key = { photoId: 'a', status: 'unreviewed', capturedAt: '2026' };
    expect(decodeCursor(encodeCursor(key))).toEqual(key);
    expect(encodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(() => decodeCursor('!!!')).toThrow(BadCursor);
    expect(() => decodeCursor(Buffer.from('[1]').toString('base64url'))).toThrow(BadCursor);
  });
});
