import { createServer, constants, type Http2Server } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  QUIET_MS,
  apnsJwt,
  createApnsPush,
  createDynamoDeviceStore,
  createMemoryDeviceStore,
  createNotificationService,
  donePayload,
  isDeviceToken,
  onQuiet,
  onUploads,
  pushResult,
  syncingPayload,
  type PushFn,
} from '../src/notifications.js';
import { createNotifierHandler, insertedUploads } from '../src/notifier.js';
import { createApp } from '../src/app.js';
import { body, deps, ev, fakeStore, item } from './helpers.js';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const min = 60_000;
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

const later = () => vi.fn<(lastUploadAt: string) => Promise<void>>(async () => undefined);
const okPush = () => vi.fn<PushFn>(async (tokens) => tokens.map((token) => ({ token, ok: true as const })));
const phone = { token: TOKEN_A, platform: 'ios' as const, registeredAt: at(0) };
const quiet = () => undefined;

describe('a burst: "syncing" on the first photo, "done" once it goes quiet', () => {
  it('pushes "syncing" once per burst and queues a quiet check for every batch', async () => {
    const devices = createMemoryDeviceStore([phone]);
    const push = okPush();
    const q = later();
    const deps = { store: fakeStore(), devices, push, later: q, now: () => new Date(T0), log: quiet };
    expect(await onUploads([at(0)], deps)).toEqual({ started: true });
    expect(await onUploads([at(1 * min), at(2 * min)], deps)).toEqual({ started: false });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith([TOKEN_A], syncingPayload());
    expect(q.mock.calls.map((c) => c[0])).toEqual([at(0), at(2 * min)]);
    expect(devices.burst).toMatchObject({ count: 3, lastUploadAt: at(2 * min) });
  });

  it('only the check for the newest photo closes the burst, and says how many with the badge', async () => {
    const devices = createMemoryDeviceStore([phone], { startedAt: at(0), lastUploadAt: at(2 * min), count: 3 });
    const push = okPush();
    const deps = { store: fakeStore(), devices, push, later: later(), log: quiet };
    // An earlier photo's check comes due: a newer photo arrived since, so nothing happens.
    expect(await onQuiet(at(0), deps)).toEqual({ done: false });
    expect(push).not.toHaveBeenCalled();
    // fakeStore counts 5 unreviewed.
    expect(await onQuiet(at(2 * min), deps)).toMatchObject({ done: true, count: 3, delivered: 1 });
    expect(push).toHaveBeenCalledWith([TOKEN_A], donePayload(3, 5));
    expect(donePayload(3, 5).aps).toMatchObject({ alert: { body: 'Done: 3 new photos synced. 5 to review.' }, badge: 5 });
    expect(donePayload(1, 1).aps.alert?.body).toBe('Done: 1 new photo synced. 1 to review.');
    expect(devices.burst).toBeUndefined();
    // A duplicate delivery of the same message finds the burst already closed.
    expect(await onQuiet(at(2 * min), deps)).toEqual({ done: false });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('the next shoot is a new burst with its own "syncing"', async () => {
    const devices = createMemoryDeviceStore([phone]);
    const push = okPush();
    const deps = { store: fakeStore(), devices, push, later: later(), now: () => new Date(T0), log: quiet };
    await onUploads([at(0)], deps);
    await onQuiet(at(0), deps);
    expect(await onUploads([at(60 * min)], deps)).toEqual({ started: true });
    expect(push.mock.calls.map((c) => c[1].kind)).toEqual(['syncing', 'done', 'syncing']);
  });

  it('a burst left open by a lost check does not swallow the next "syncing"', async () => {
    const devices = createMemoryDeviceStore([phone], { startedAt: at(0), lastUploadAt: at(0), count: 4 });
    const push = okPush();
    const deps = { store: fakeStore(), devices, push, later: later(), now: () => new Date(T0 + 2 * QUIET_MS + 1), log: quiet };
    expect(await onUploads([at(2 * QUIET_MS)], deps)).toEqual({ started: true });
    expect(devices.burst?.count).toBe(1);
  });

  it('forgets tokens Apple says are gone', async () => {
    const devices = createMemoryDeviceStore([phone, { token: TOKEN_B, platform: 'ios', registeredAt: at(0) }], { startedAt: at(0), lastUploadAt: at(0), count: 1 });
    const push: PushFn = async (tokens) => tokens.map((token) => (token === TOKEN_B ? pushResult(token, 410, '{"reason":"Unregistered"}') : { token, ok: true as const }));
    expect(await onQuiet(at(0), { store: fakeStore(), devices, push, later: later(), log: quiet })).toMatchObject({ delivered: 1, removed: 1 });
    expect(devices.devices.map((d) => d.token)).toEqual([TOKEN_A]);
  });

  it('tracks bursts without an APNs key and sends nothing', async () => {
    const devices = createMemoryDeviceStore();
    const deps = { store: fakeStore(), devices, push: null, later: later(), now: () => new Date(T0), log: quiet };
    expect(await onUploads([at(0)], deps)).toEqual({ started: true });
    expect(await onQuiet(at(0), deps)).toEqual({ done: true, count: 1 });
  });
});

describe('notifier handler', () => {
  const insert = (eventName: 'INSERT' | 'MODIFY', uploadedAt: string) => ({
    eventSource: 'aws:dynamodb',
    eventName,
    dynamodb: { NewImage: marshall(item('x', 'unreviewed', { uploadedAt })) },
  });

  it('counts only inserts from the stream (a re-sent frame is a MODIFY)', () => {
    const event = { Records: [insert('INSERT', at(0)), insert('MODIFY', at(1 * min)), insert('INSERT', at(2 * min))] } as unknown as DynamoDBStreamEvent;
    expect(insertedUploads(event)).toEqual([at(0), at(2 * min)]);
  });

  it('routes stream batches to onUploads and queue messages to onQuiet', async () => {
    const devices = createMemoryDeviceStore([phone]);
    const push = okPush();
    const q = later();
    const handle = createNotifierHandler(async () => ({ store: fakeStore(), devices, push, later: q, now: () => new Date(T0), log: quiet }));
    await handle({ Records: [insert('INSERT', at(0))] } as unknown as DynamoDBStreamEvent);
    expect(q).toHaveBeenCalledWith(at(0));
    await handle({ Records: [{ eventSource: 'aws:sqs', body: JSON.stringify({ lastUploadAt: at(0) }) }] } as unknown as SQSEvent);
    expect(push.mock.calls.map((c) => c[1].kind)).toEqual(['syncing', 'done']);
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
    const results = await push([TOKEN_A, TOKEN_B], donePayload(4, 9));
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

describe('DynamoDB burst row', () => {
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

  it('adds to the burst in one atomic write and starts it only when there was none', async () => {
    const { ddb, inputs } = fake(() => ({ Attributes: undefined }));
    expect(await createDynamoDeviceStore('n', ddb).noteUploads(2, at(1 * min), at(0))).toEqual({ started: true });
    expect(inputs[0]).toMatchObject({
      Key: { pk: 'burst', sk: 'burst' },
      UpdateExpression: 'SET startedAt = if_not_exists(startedAt, :now), lastUploadAt = :last ADD #c :n',
      ExpressionAttributeValues: { ':now': at(0), ':last': at(1 * min), ':n': 2 },
      ReturnValues: 'UPDATED_OLD',
    });
    const busy = fake(() => ({ Attributes: { startedAt: at(-1 * min), lastUploadAt: at(0), count: 3 } }));
    expect(await createDynamoDeviceStore('n', busy.ddb).noteUploads(1, at(1 * min), at(1 * min))).toEqual({ started: false });
  });

  it('closes only if no newer photo arrived, and reads a failed condition as "not mine to close"', async () => {
    const burst = { startedAt: at(0), lastUploadAt: at(2 * min), count: 3 };
    const { ddb, inputs } = fake(() => ({ Attributes: burst }));
    expect(await createDynamoDeviceStore('n', ddb).closeBurst(at(2 * min))).toEqual(burst);
    expect(inputs[0]).toMatchObject({ ConditionExpression: 'lastUploadAt = :last', ExpressionAttributeValues: { ':last': at(2 * min) }, ReturnValues: 'ALL_OLD' });
    const moved = fake(() => {
      throw Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' });
    });
    expect(await createDynamoDeviceStore('n', moved.ddb).closeBurst(at(0))).toBeUndefined();
  });
});
