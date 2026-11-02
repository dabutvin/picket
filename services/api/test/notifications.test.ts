import { createServer, constants, type Http2Server } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAPSE_ID,
  apnsJwt,
  createApnsPush,
  createDynamoDeviceStore,
  createMemoryDeviceStore,
  createNotificationService,
  isDeviceToken,
  onUploads,
  pushResult,
  syncingPayload,
  type Device,
  type PushFn,
} from '../src/notifications.js';
import { createNotifierHandler, insertedCount } from '../src/notifier.js';
import { createApp } from '../src/app.js';
import { body, deps, ev, fakeStore } from './helpers.js';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const min = 60_000;
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const phone = (token: string, extra: Partial<Device> = {}): Device => ({ token, platform: 'ios', openedAt: at(-60 * min), ...extra });
const okPush = () => vi.fn<PushFn>(async (tokens) => tokens.map((token) => ({ token, ok: true as const })));
const quiet = () => undefined;

describe('one "syncing" push, then nothing until the app is opened', () => {
  it('notifies on the first new photos, with the unreviewed count as the badge and the shared collapse id', async () => {
    const devices = createMemoryDeviceStore([phone(TOKEN_A)]);
    const push = okPush();
    const out = await onUploads(3, { store: fakeStore(), devices, push, now: () => new Date(T0), log: quiet });
    expect(out).toMatchObject({ notified: 1 });
    // fakeStore counts 5 unreviewed.
    expect(push).toHaveBeenCalledWith([TOKEN_A], syncingPayload(5), { collapseId: COLLAPSE_ID });
    expect(syncingPayload(5).aps).toMatchObject({ alert: { body: 'New photos are syncing from your camera.' }, badge: 5 });
    expect(devices.devices[0]!.notifiedAt).toBe(at(0));
  });

  it('stays silent for the rest of the batch, later batches and a live shoot, until the app is opened', async () => {
    const devices = createMemoryDeviceStore([phone(TOKEN_A)]);
    const push = okPush();
    let now = T0;
    const d = { store: fakeStore(), devices, push, now: () => new Date(now), log: quiet };
    await onUploads(1, d);
    for (const later of [10_000, 30 * min, 3 * 60 * min]) {
      now = T0 + later;
      expect(await onUploads(5, d)).toEqual({ notified: 0 });
    }
    expect(push).toHaveBeenCalledTimes(1);
    // Opening the app re-arms it: the next new photo notifies again.
    await devices.opened(TOKEN_A, undefined, at(4 * 60 * min));
    now = T0 + 5 * 60 * min;
    expect(await onUploads(1, d)).toMatchObject({ notified: 1 });
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('decides per phone: one that already has an unread push is skipped, the other is told', async () => {
    const devices = createMemoryDeviceStore([phone(TOKEN_A, { notifiedAt: at(-1 * min) }), phone(TOKEN_B)]);
    const push = okPush();
    await onUploads(2, { store: fakeStore(), devices, push, now: () => new Date(T0), log: quiet });
    expect(push).toHaveBeenCalledWith([TOKEN_B], expect.anything(), expect.anything());
  });

  it('forgets tokens Apple says are gone', async () => {
    const devices = createMemoryDeviceStore([phone(TOKEN_A), phone(TOKEN_B)]);
    const push: PushFn = async (tokens) => tokens.map((token) => (token === TOKEN_B ? pushResult(token, 410, '{"reason":"Unregistered"}') : { token, ok: true as const }));
    expect(await onUploads(1, { store: fakeStore(), devices, push, now: () => new Date(T0), log: quiet })).toMatchObject({ delivered: 1, removed: 1 });
    expect(devices.devices.map((d) => d.token)).toEqual([TOKEN_A]);
  });

  it('claims nothing without an APNs key, so the first push after the key is added still goes out', async () => {
    const devices = createMemoryDeviceStore([phone(TOKEN_A)]);
    expect(await onUploads(4, { store: fakeStore(), devices, push: null, log: quiet })).toEqual({ notified: 0 });
    expect(devices.devices[0]!.notifiedAt).toBeUndefined();
  });
});

describe('notifier handler', () => {
  it('counts only inserts (a re-sent frame is a MODIFY) and notifies', async () => {
    const event = { Records: [{ eventName: 'INSERT' }, { eventName: 'MODIFY' }, { eventName: 'INSERT' }] } as unknown as DynamoDBStreamEvent;
    expect(insertedCount(event)).toBe(2);
    const push = okPush();
    const handle = createNotifierHandler(async () => ({ store: fakeStore(), devices: createMemoryDeviceStore([phone(TOKEN_A)]), push, log: quiet }));
    expect(await handle(event)).toMatchObject({ notified: 1 });
    expect(await handle({ Records: [{ eventName: 'MODIFY' }] } as unknown as DynamoDBStreamEvent)).toEqual({ notified: 0 });
  });
});

const ecKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { p8: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey };
};

describe('pushResult', () => {
  it('treats 410 and bad tokens as gone, other errors as transient', () => {
    expect(pushResult(TOKEN_A, 200, '')).toEqual({ token: TOKEN_A, ok: true });
    expect(pushResult(TOKEN_A, 410, '{"reason":"Unregistered"}')).toMatchObject({ gone: true, reason: 'Unregistered' });
    expect(pushResult(TOKEN_A, 400, '{"reason":"BadDeviceToken"}')).toMatchObject({ gone: true });
    expect(pushResult(TOKEN_A, 403, '{"reason":"InvalidProviderToken"}')).toMatchObject({ gone: false, status: 403 });
    expect(pushResult(TOKEN_A, 500, 'oops')).toMatchObject({ gone: false, reason: 'oops' });
  });
});


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
    const seen: { path: string; topic: string; auth: string; collapse: string; body: string }[] = [];
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c));
      req.on('end', () => {
        seen.push({ path: req.headers[constants.HTTP2_HEADER_PATH] as string, topic: req.headers['apns-topic'] as string, collapse: req.headers['apns-collapse-id'] as string, auth: req.headers.authorization as string, body: data });
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
    const results = await push([TOKEN_A, TOKEN_B], syncingPayload(9), { collapseId: COLLAPSE_ID });
    expect(results).toEqual([
      { token: TOKEN_A, ok: true },
      { token: TOKEN_B, ok: false, status: 410, reason: 'Unregistered', gone: true },
    ]);
    expect(seen.map((s) => s.path).sort()).toEqual([`/3/device/${TOKEN_A}`, `/3/device/${TOKEN_B}`]);
    expect(seen[0]!.topic).toBe('com.danbut.picket');
    expect(seen[0]!.collapse).toBe(COLLAPSE_ID);
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

describe('DynamoDB device rows', () => {
  const fake = (reply: (input: Record<string, unknown>) => unknown) => {
    const inputs: Record<string, unknown>[] = [];
    const ddb = {
      send: async (cmd: { input: Record<string, unknown> }) => {
        inputs.push(cmd.input);
        return reply(cmd.input);
      },
    } as unknown as DynamoDBDocumentClient;
    return { ddb, inputs };
  };

  it('opening the app updates the row in place, keeping notifiedAt', async () => {
    const { ddb, inputs } = fake(() => ({}));
    await createDynamoDeviceStore('n', ddb).opened(TOKEN_A, 'iPhone', at(0));
    expect(inputs[0]).toMatchObject({
      Key: { pk: 'devices', sk: `device#${TOKEN_A}` },
      UpdateExpression: 'SET #t = :t, platform = :p, openedAt = :now, #n = :n',
      ExpressionAttributeValues: { ':t': TOKEN_A, ':p': 'ios', ':now': at(0), ':n': 'iPhone' },
    });
  });

  it('claims a phone only if it holds no unread push, and reads a failed condition as "already told"', async () => {
    const { ddb, inputs } = fake(() => ({}));
    expect(await createDynamoDeviceStore('n', ddb).claim(TOKEN_A, at(0))).toBe(true);
    expect(inputs[0]).toMatchObject({
      UpdateExpression: 'SET notifiedAt = :now',
      ConditionExpression: 'attribute_exists(sk) AND (attribute_not_exists(notifiedAt) OR notifiedAt <= openedAt)',
    });
    const told = fake(() => {
      throw Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' });
    });
    expect(await createDynamoDeviceStore('n', told.ddb).claim(TOKEN_A, at(0))).toBe(false);
  });
});
