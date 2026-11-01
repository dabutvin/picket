import { createServer, constants, type Http2Server } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_WAIT_MS,
  QUIET_MS,
  apnsJwt,
  createApnsPush,
  createMemoryDeviceStore,
  createNotificationService,
  isDeviceToken,
  newPhotosPayload,
  planNotification,
  pushResult,
  runNotifier,
  type PushFn,
} from '../src/notifications.js';
import { createApp } from '../src/app.js';
import { body, deps, ev, fakeStore, item } from './helpers.js';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const min = 60_000;
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

describe('planNotification', () => {
  it('starts the watermark at now without announcing the backlog', () => {
    expect(planNotification(undefined, [at(-60 * min)], new Date(T0))).toEqual({ action: 'start', watermark: at(0) });
  });

  it('does nothing when nothing arrived after the watermark', () => {
    expect(planNotification(at(0), [at(-5 * min), at(0)], new Date(T0 + 10 * min))).toEqual({ action: 'none' });
  });

  it('waits while a burst is still arriving, then sends one count', () => {
    const uploads = [at(1 * min), at(2 * min), at(3 * min)];
    expect(planNotification(at(0), uploads, new Date(T0 + 3 * min + QUIET_MS - 1))).toEqual({ action: 'wait' });
    expect(planNotification(at(0), uploads, new Date(T0 + 3 * min + QUIET_MS))).toEqual({ action: 'send', count: 3, watermark: at(3 * min) });
  });

  it('still says something during a long shoot', () => {
    const uploads = [at(1 * min), at(1 * min + MAX_WAIT_MS)];
    expect(planNotification(at(0), uploads, new Date(T0 + 1 * min + MAX_WAIT_MS))).toEqual({ action: 'send', count: 2, watermark: uploads[1] });
  });

  it('compares instants, not strings (the preview fallback writes +00:00)', () => {
    const plan = planNotification(at(0), ['2026-11-01T10:01:00+00:00'], new Date(T0 + 1 * min + QUIET_MS));
    expect(plan).toEqual({ action: 'send', count: 1, watermark: at(1 * min) });
  });
});

describe('runNotifier', () => {
  const storeWith = (uploads: string[]) => {
    const store = fakeStore();
    store.listByStatus = vi.fn(async () => ({ items: uploads.map((u, i) => item(`p${i}`, 'unreviewed', { uploadedAt: u })) }));
    return store;
  };

  it('pushes the count with the whole unreviewed backlog as the badge, and moves the watermark', async () => {
    const devices = createMemoryDeviceStore([{ token: TOKEN_A, platform: 'ios', registeredAt: at(0) }], { watermark: at(0) });
    const push = vi.fn<PushFn>(async (tokens) => tokens.map((token) => ({ token, ok: true as const })));
    // One photo from before the watermark still waits unreviewed: it counts toward the badge only.
    const store = storeWith([at(-30 * min), at(1 * min), at(2 * min)]);
    const out = await runNotifier({ store, devices, push, now: () => new Date(T0 + 2 * min + QUIET_MS), log: () => undefined });
    expect(out).toMatchObject({ action: 'send', count: 2, delivered: 1 });
    expect(push).toHaveBeenCalledWith([TOKEN_A], newPhotosPayload(2, 3));
    expect(newPhotosPayload(2, 3).aps).toMatchObject({ alert: { body: '2 new photos to review' }, badge: 3 });
    expect(newPhotosPayload(1, 1).aps.alert?.body).toBe('1 new photo to review');
    expect(devices.state.watermark).toBe(at(2 * min));
  });

  it('forgets tokens Apple says are gone', async () => {
    const devices = createMemoryDeviceStore(
      [
        { token: TOKEN_A, platform: 'ios', registeredAt: at(0) },
        { token: TOKEN_B, platform: 'ios', registeredAt: at(0) },
      ],
      { watermark: at(0) },
    );
    const push: PushFn = async (tokens) => tokens.map((token) => (token === TOKEN_B ? pushResult(token, 410, '{"reason":"Unregistered"}') : { token, ok: true as const }));
    const out = await runNotifier({ store: storeWith([at(1 * min)]), devices, push, now: () => new Date(T0 + 1 * min + QUIET_MS), log: () => undefined });
    expect(out).toMatchObject({ delivered: 1, removed: 1 });
    expect(devices.devices.map((d) => d.token)).toEqual([TOKEN_A]);
  });

  it('keeps the watermark moving without an APNs key, so turning it on later announces nothing stale', async () => {
    const devices = createMemoryDeviceStore([], { watermark: at(0) });
    const out = await runNotifier({ store: storeWith([at(1 * min)]), devices, push: null, now: () => new Date(T0 + 1 * min + QUIET_MS), log: () => undefined });
    expect(out.action).toBe('send');
    expect(devices.state.watermark).toBe(at(1 * min));
  });
});

describe('pushResult', () => {
  it('treats 410 and bad tokens as gone, other errors as transient', () => {
    expect(pushResult(TOKEN_A, 200, '')).toEqual({ token: TOKEN_A, ok: true });
    expect(pushResult(TOKEN_A, 410, '{"reason":"Unregistered"}')).toMatchObject({ gone: true, reason: 'Unregistered' });
    expect(pushResult(TOKEN_A, 400, '{"reason":"BadDeviceToken"}')).toMatchObject({ gone: true });
    expect(pushResult(TOKEN_A, 403, '{"reason":"InvalidProviderToken"}')).toMatchObject({ gone: false, status: 403 });
    expect(pushResult(TOKEN_A, 500, 'oops')).toMatchObject({ gone: false, reason: 'oops' });
  });
});

const ecKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { p8: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
};

describe('apnsJwt', () => {
  it('is an ES256 token Apple can verify with the key id and team id', () => {
    const { p8, publicKey } = ecKey();
    const jwt = apnsJwt({ keyId: 'KEY123', teamId: 'TEAM45', p8 }, T0);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ iss: 'TEAM45', iat: T0 / 1000 });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
  });
});

describe('createApnsPush', () => {
  let server: Http2Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('POSTs each token over one HTTP/2 connection with the topic and bearer token', async () => {
    const seen: { path: string; topic: string; auth: string; body: string }[] = [];
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c));
      req.on('end', () => {
        seen.push({ path: req.headers[constants.HTTP2_HEADER_PATH] as string, topic: req.headers['apns-topic'] as string, auth: req.headers.authorization as string, body: data });
        if ((req.headers[constants.HTTP2_HEADER_PATH] as string).endsWith(TOKEN_B)) {
          res.writeHead(410).end('{"reason":"Unregistered"}');
        } else {
          res.writeHead(200).end();
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const push = createApnsPush({ keyId: 'K', teamId: 'T', ...ecKey() }, 'com.danbut.picket', `http://localhost:${port}`);
    const results = await push([TOKEN_A, TOKEN_B], newPhotosPayload(4, 9));
    expect(results).toEqual([
      { token: TOKEN_A, ok: true },
      { token: TOKEN_B, ok: false, status: 410, reason: 'Unregistered', gone: true },
    ]);
    expect(seen.map((s) => s.path).sort()).toEqual([`/3/device/${TOKEN_A}`, `/3/device/${TOKEN_B}`]);
    expect(seen[0]!.topic).toBe('com.danbut.picket');
    expect(seen[0]!.auth).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(seen[0]!.body).aps.badge).toBe(9);
  });
});

describe('device routes', () => {
  const setup = (configured = true) => {
    const devices = createMemoryDeviceStore();
    const push: PushFn = async (tokens) => tokens.map((token) => ({ token, ok: true as const }));
    const notifications = createNotificationService(devices, async () => (configured ? push : null), () => undefined);
    return { devices, app: createApp(deps({ notifications })) };
  };

  it('registers a phone (case-insensitively) and reports whether pushes can go out', async () => {
    const { devices, app } = setup(false);
    const r = await app(ev('POST /devices', { body: JSON.stringify({ token: TOKEN_A.toUpperCase(), name: 'iPhone' }) }));
    expect(r.statusCode).toBe(200);
    expect(body(r)).toEqual({ configured: false, devices: 1 });
    expect(devices.devices[0]).toMatchObject({ token: TOKEN_A, name: 'iPhone', platform: 'ios' });
    // Registering again is a refresh, not a second device.
    await app(ev('POST /devices', { body: JSON.stringify({ token: TOKEN_A }) }));
    expect(devices.devices).toHaveLength(1);
  });

  it('rejects anything that is not a device token', async () => {
    const { app } = setup();
    expect((await app(ev('POST /devices', { body: '{"token":"ExponentPushToken[xyz]"}' }))).statusCode).toBe(400);
    expect((await app(ev('POST /devices', { body: 'nope' }))).statusCode).toBe(400);
    expect((await app(ev('DELETE /devices/{token}', { pathParameters: { token: 'short' } }))).statusCode).toBe(400);
  });

  it('unregisters and sends a test push', async () => {
    const { devices, app } = setup();
    await app(ev('POST /devices', { body: JSON.stringify({ token: TOKEN_A }) }));
    expect(body(await app(ev('POST /notifications/test')))).toEqual({ configured: true, attempted: 1, delivered: 1, removed: 0 });
    await app(ev('DELETE /devices/{token}', { pathParameters: { token: TOKEN_A } }));
    expect(devices.devices).toHaveLength(0);
  });

  it('404s when the stack has no notifications', async () => {
    const app = createApp(deps());
    expect((await app(ev('POST /devices', { body: JSON.stringify({ token: TOKEN_A }) }))).statusCode).toBe(404);
  });

  it('only accepts hex tokens', () => {
    expect(isDeviceToken(TOKEN_A)).toBe(true);
    expect(isDeviceToken('g'.repeat(64))).toBe(false);
  });
});
