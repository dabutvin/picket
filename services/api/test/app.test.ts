import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMemoryConnectionStore } from '../src/connection.js';
import { BadCursor, decodeCursor, encodeCursor } from '../src/store.js';
import { body, connection, deps, ev, fakeFetch, lrJson } from './helpers.js';

describe('GET /photos', () => {
  it('defaults to unreviewed and attaches presigned urls', async () => {
    const d = deps();
    const r = await createApp(d)(ev('GET /photos'));
    expect(r.statusCode).toBe(200);
    expect(d.store.listByStatus).toHaveBeenCalledWith('unreviewed', 30, undefined);
    const b = body(r);
    expect(b.items).toHaveLength(2);
    expect(b.items[0].previewUrl).toBe('https://s3/previews/a.jpg?ttl=3600');
    expect(b.items[0].thumbUrl).toBe('https://s3/thumbs/a.jpg?ttl=3600');
    expect(b.cursor).toBeUndefined();
  });

  it('passes status, clamps limit, returns cursor', async () => {
    const d = deps();
    const r = await createApp(d)(ev('GET /photos', { queryStringParameters: { status: 'pick', limit: '1' } }));
    expect(d.store.listByStatus).toHaveBeenCalledWith('pick', 1, undefined);
    expect(body(r).cursor).toBe('next');
    await createApp(d)(ev('GET /photos', { queryStringParameters: { limit: '5000' } }));
    expect(d.store.listByStatus).toHaveBeenLastCalledWith('unreviewed', 100, undefined);
  });

  it('rejects bad status, limit and cursor', async () => {
    const app = createApp(deps());
    expect((await app(ev('GET /photos', { queryStringParameters: { status: 'maybe' } }))).statusCode).toBe(400);
    expect((await app(ev('GET /photos', { queryStringParameters: { limit: '0' } }))).statusCode).toBe(400);
    expect((await app(ev('GET /photos', { queryStringParameters: { cursor: 'bad' } }))).statusCode).toBe(400);
  });
});

describe('POST /photos/{id}/decision', () => {
  it('updates and returns the photo', async () => {
    const d = deps();
    const r = await createApp(d)(ev('POST /photos/{id}/decision', { pathParameters: { id: 'a' }, body: JSON.stringify({ decision: 'pick' }) }));
    expect(r.statusCode).toBe(200);
    expect(d.store.setStatus).toHaveBeenCalledWith('a', 'pick');
    expect(body(r).status).toBe('pick');
  });

  it('404s on unknown photo, 400s on bad body', async () => {
    const app = createApp(deps());
    expect((await app(ev('POST /photos/{id}/decision', { pathParameters: { id: 'zz' }, body: '{"decision":"pick"}' }))).statusCode).toBe(404);
    expect((await app(ev('POST /photos/{id}/decision', { pathParameters: { id: 'a' }, body: '{"decision":"meh"}' }))).statusCode).toBe(400);
    expect((await app(ev('POST /photos/{id}/decision', { pathParameters: { id: 'a' }, body: 'not json' }))).statusCode).toBe(400);
  });
});

describe('GET /photos/{id}/raw-url', () => {
  it('returns a short-lived download url with the original filename', async () => {
    const r = await createApp(deps())(ev('GET /photos/{id}/raw-url', { pathParameters: { id: 'a' } }));
    expect(r.statusCode).toBe(200);
    expect(body(r)).toEqual({ url: 'https://s3/raw/2026/10/30/a.ARW?ttl=900&dl=a.ARW', fileName: 'a.ARW', bytes: 123, expiresInSeconds: 900 });
  });
  it('404s on unknown photo', async () => {
    expect((await createApp(deps())(ev('GET /photos/{id}/raw-url', { pathParameters: { id: 'zz' } }))).statusCode).toBe(404);
  });
});

describe('POST /photos/{id}/lightroom (retry)', () => {
  it('requeues a pick and 409s otherwise', async () => {
    const d = deps();
    const app = createApp(d);
    const r = await app(ev('POST /photos/{id}/lightroom', { pathParameters: { id: 'a' } }));
    expect(r.statusCode).toBe(200);
    expect(d.store.requeueLightroom).toHaveBeenCalledWith('a');
    expect(body(r).lightroomStatus).toBe('queued');
    expect((await app(ev('POST /photos/{id}/lightroom', { pathParameters: { id: 'zz' } }))).statusCode).toBe(409);
  });
});

describe('GET /stats', () => {
  it('counts every status', async () => {
    const r = await createApp(deps())(ev('GET /stats'));
    expect(body(r)).toEqual({
      photos: { unreviewed: 5, pick: 2, reject: 7 },
      lightroom: { queued: 1, uploading: 0, done: 1, duplicate: 0, failed: 0 },
    });
  });
});

describe('Lightroom connection', () => {
  it('GET /lightroom reports disconnected with oauth config', async () => {
    const r = await createApp(deps())(ev('GET /lightroom'));
    const b = body(r);
    expect(b.connected).toBe(false);
    expect(b.oauth.clientId).toBe('cid');
    expect(b.oauth.authorizeUrl).toContain('ims-na1.adobelogin.com');
    expect(b.albumName).toBe('Picket');
  });

  it('POST /lightroom verifies entitlement + catalog and stores the connection', async () => {
    const { fn, calls } = fakeFetch({
      'GET /v2/account': () => lrJson({ id: 'acct1', email: 'dan@example.com', entitlement: { status: 'subscriber', storage: { used: 10, limit: 100 } } }),
      'GET /v2/catalog': () => lrJson({ id: 'cat1' }),
    });
    const connections = createMemoryConnectionStore(null);
    const app = createApp(deps({ connections, fetchFn: fn }));
    const r = await app(ev('POST /lightroom', { body: JSON.stringify({ refreshToken: 'rt', accessToken: 'at', expiresIn: 3600 }) }));
    expect(r.statusCode).toBe(200);
    const b = body(r);
    expect(b).toMatchObject({ connected: true, email: 'dan@example.com', catalogId: 'cat1', storage: { used: 10, limit: 100 } });
    expect(JSON.stringify(b)).not.toContain('rt'); // tokens never leave the server
    const saved = await connections.load();
    expect(saved).toMatchObject({ refreshToken: 'rt', accessToken: 'at', catalogId: 'cat1', accountId: 'acct1' });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('cid');
    expect(headers.Authorization).toBe('Bearer at');
  });

  it('POST /lightroom refreshes when only a refresh token is given', async () => {
    const { fn } = fakeFetch({
      'POST /ims/token/v3': () => new Response(JSON.stringify({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 86399 })),
      'GET /v2/account': () => lrJson({ id: 'acct1', email: 'd@e.com', entitlement: { status: 'trial' } }),
      'GET /v2/catalog': () => lrJson({ id: 'cat1' }),
    });
    const connections = createMemoryConnectionStore(null);
    const r = await createApp(deps({ connections, fetchFn: fn }))(ev('POST /lightroom', { body: JSON.stringify({ refreshToken: 'rt' }) }));
    expect(r.statusCode).toBe(200);
    expect(await connections.load()).toMatchObject({ refreshToken: 'new-rt', accessToken: 'new-at' });
  });

  it('POST /lightroom rejects unentitled accounts and Adobe failures without storing', async () => {
    const connections = createMemoryConnectionStore(null);
    const unentitled = fakeFetch({ 'GET /v2/account': () => lrJson({ id: 'x', email: 'x', entitlement: { status: 'free' } }) });
    let r = await createApp(deps({ connections, fetchFn: unentitled.fn }))(ev('POST /lightroom', { body: '{"refreshToken":"rt","accessToken":"at"}' }));
    expect(r.statusCode).toBe(403);
    const broken = fakeFetch({ 'GET /v2/account': () => new Response('{"error_code":"403003"}', { status: 403 }) });
    r = await createApp(deps({ connections, fetchFn: broken.fn }))(ev('POST /lightroom', { body: '{"refreshToken":"rt","accessToken":"at"}' }));
    expect(r.statusCode).toBe(502);
    expect(await connections.load()).toBeNull();
    expect((await createApp(deps())(ev('POST /lightroom', { body: '{}' }))).statusCode).toBe(400);
  });

  it('keeps the album id across reconnects to the same catalog', async () => {
    const { fn } = fakeFetch({
      'GET /v2/account': () => lrJson({ id: 'acct1', email: 'd@e.com', entitlement: { status: 'subscriber' } }),
      'GET /v2/catalog': () => lrJson({ id: 'cat1' }),
    });
    const connections = createMemoryConnectionStore(connection({ albumId: 'alb1' }));
    const r = await createApp(deps({ connections, fetchFn: fn }))(ev('POST /lightroom', { body: '{"refreshToken":"rt2","accessToken":"at2"}' }));
    expect(body(r).albumId).toBe('alb1');
  });

  it('DELETE /lightroom clears; POST /lightroom/refresh updates storage', async () => {
    const connections = createMemoryConnectionStore(connection());
    const { fn } = fakeFetch({
      'GET /v2/account': () => lrJson({ id: 'acct1', email: 'd@e.com', entitlement: { status: 'subscriber', storage: { used: 50, limit: 100 } } }),
    });
    const app = createApp(deps({ connections, fetchFn: fn }));
    expect(body(await app(ev('POST /lightroom/refresh'))).storage).toEqual({ used: 50, limit: 100 });
    expect(body(await app(ev('DELETE /lightroom'))).connected).toBe(false);
    expect(await connections.load()).toBeNull();
    expect((await app(ev('POST /lightroom/refresh'))).statusCode).toBe(404);
  });
});

describe('routing', () => {
  it('404s unknown routes and 500s on store failure', async () => {
    const d = deps();
    (d.store.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const app = createApp(d);
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
