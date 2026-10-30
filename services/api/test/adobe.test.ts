import { describe, expect, it } from 'vitest';
import { AdobeError, LightroomClient, contentTypeFor, newLightroomId, parseLightroomJson, refreshTokens } from '../src/adobe.js';
import { fakeFetch, lrJson } from './helpers.js';

describe('parseLightroomJson', () => {
  it('strips the while(1) guard', () => {
    expect(parseLightroomJson('while (1) {}\n{"a":1}')).toEqual({ a: 1 });
    expect(parseLightroomJson('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('newLightroomId', () => {
  it('is a 32-char hex GUID without hyphens', () => {
    expect(newLightroomId()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('refreshTokens', () => {
  it('posts a public-client refresh and keeps the old refresh token if none is returned', async () => {
    const { fn, calls } = fakeFetch({
      'POST /ims/token/v3': () => new Response(JSON.stringify({ access_token: 'at2', expires_in: 100 })),
    });
    const t = await refreshTokens(fn, 'cid', 'rt');
    expect(t.accessToken).toBe('at2');
    expect(t.refreshToken).toBe('rt');
    expect(Date.parse(t.expiresAt)).toBeGreaterThan(Date.now() + 90_000);
    const sent = calls[0]!.init!.body as URLSearchParams;
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('client_id')).toBe('cid');
    expect(sent.has('client_secret')).toBe(false);
  });
  it('throws AdobeError on failure', async () => {
    const { fn } = fakeFetch({ 'POST /ims/token/v3': () => new Response('{"error":"invalid_grant"}', { status: 400 }) });
    await expect(refreshTokens(fn, 'cid', 'rt')).rejects.toBeInstanceOf(AdobeError);
  });
});

describe('LightroomClient', () => {
  const asset = { fileName: 'DSC1.ARW', captureDate: '2026-10-30T10:00:00', importedBy: 'acct', importTimestamp: 'now', sha256: 'abc', fileSize: 3 };

  it('sends api key + bearer, parses guarded json', async () => {
    const { fn, calls } = fakeFetch({ 'GET /v2/catalog': () => lrJson({ id: 'cat1' }) });
    const c = new LightroomClient(fn, 'key', 'tok');
    expect(await c.catalog()).toEqual({ id: 'cat1' });
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(h).toMatchObject({ 'X-API-Key': 'key', Authorization: 'Bearer tok' });
    expect(calls[0]!.url).toBe('https://lr.adobe.io/v2/catalog');
  });

  it('createAsset tags importedOnDevice with the api key and reports duplicates', async () => {
    const { fn, calls } = fakeFetch({
      'PUT /v2/catalogs/cat1/assets/a1': (init) => {
        const b = JSON.parse(init!.body as string);
        expect(b.subtype).toBe('image');
        expect(b.payload.importSource).toMatchObject({ fileName: 'DSC1.ARW', importedOnDevice: 'key', sha256: 'abc', fileSize: 3 });
        return new Response(null, { status: 201 });
      },
      'PUT /v2/catalogs/cat1/assets/dup': () => new Response(null, { status: 412 }),
      'PUT /v2/catalogs/cat1/assets/bad': () => new Response('{"error_code":"1005"}', { status: 400 }),
    });
    const c = new LightroomClient(fn, 'key', 'tok');
    expect(await c.createAsset('cat1', 'a1', asset)).toBe('created');
    expect(await c.createAsset('cat1', 'dup', asset)).toBe('duplicate');
    await expect(c.createAsset('cat1', 'bad', asset)).rejects.toMatchObject({ status: 400, permanent: true });
    expect(calls).toHaveLength(3);
  });

  it('uploadMaster sends raw bytes with content type and length', async () => {
    const { fn, calls } = fakeFetch({ 'PUT /v2/catalogs/cat1/assets/a1/master': () => new Response(null, { status: 201 }) });
    const c = new LightroomClient(fn, 'key', 'tok');
    await c.uploadMaster('cat1', 'a1', new Uint8Array([1, 2, 3]), 'image/x-sony-arw');
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(h['content-type']).toBe('image/x-sony-arw');
    expect(h['content-length']).toBe('3');
  });

  it('413 and 415 are permanent, 429 and 5xx are not', async () => {
    const { fn } = fakeFetch({
      'PUT /v2/catalogs/cat1/assets/full/master': () => new Response('{"error_code":"1007"}', { status: 413 }),
      'PUT /v2/catalogs/cat1/assets/busy/master': () => new Response('', { status: 429 }),
    });
    const c = new LightroomClient(fn, 'key', 'tok');
    await expect(c.uploadMaster('cat1', 'full', new Uint8Array(1), 'x')).rejects.toMatchObject({ permanent: true });
    await expect(c.uploadMaster('cat1', 'busy', new Uint8Array(1), 'x')).rejects.toMatchObject({ permanent: false });
  });

  it('album helpers: list, create with serviceId, add in batches of 50 with remoteId', async () => {
    let adds = 0;
    const { fn } = fakeFetch({
      'GET /v2/catalogs/cat1/albums?subtype=project': () => lrJson({ resources: [{ id: 'alb1', payload: { name: 'Picket' } }] }),
      'PUT /v2/catalogs/cat1/albums/alb2/assets': (init) => {
        adds += JSON.parse(init!.body as string).resources.length;
        return new Response(null, { status: 201 });
      },
      'PUT /v2/catalogs/cat1/albums/alb2': (init) => {
        const b = JSON.parse(init!.body as string);
        expect(b).toMatchObject({ subtype: 'project', serviceId: 'key', payload: { name: 'Picket', publishInfo: { version: 3 } } });
        return new Response(null, { status: 201 });
      },
    });
    const c = new LightroomClient(fn, 'key', 'tok');
    expect(await c.listProjectAlbums('cat1')).toEqual([{ id: 'alb1', payload: { name: 'Picket' } }]);
    await c.createProjectAlbum('cat1', 'alb2', 'Picket');
    await c.addToAlbum('cat1', 'alb2', Array.from({ length: 120 }, (_, i) => ({ assetId: `a${i}`, remoteId: `p${i}` })));
    expect(adds).toBe(120);
  });
});

describe('contentTypeFor', () => {
  it('maps raw extensions and honors the override', () => {
    expect(contentTypeFor('DSC0001.ARW')).toBe('image/x-sony-arw');
    expect(contentTypeFor('x.dng')).toBe('image/x-adobe-dng');
    expect(contentTypeFor('x.bin')).toBe('application/octet-stream');
    expect(contentTypeFor('DSC0001.ARW', 'application/octet-stream')).toBe('application/octet-stream');
  });
});
