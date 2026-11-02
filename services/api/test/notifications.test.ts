import { createServer, constants, type Http2Server } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  LIVE_MS,
  QUIET_MS,
  backlogUploads,
  capturedInstant,
  apnsJwt,
  createApnsPush,
  createDynamoDeviceStore,
  createMemoryDeviceStore,
  createNotificationService,
  donePayload,
  isDeviceToken,
  onQuiet,
  onUploads,
  REMINDER_WINDOW,
  nextReminderAt,
  onReminderTick,
  pushResult,
  reminderPayload,
  syncingPayload,
  zonedTimeToUtc,
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

describe('live transfer does not count', () => {
  // 10:00Z is 03:00 on a camera set to -07:00.
  const photo = (capturedLocal: string, uploadedAt: string, capturedOffset: string | undefined = '-07:00') => ({ capturedAt: capturedLocal, capturedOffset, uploadedAt });

  it('reads the capture instant from camera-local time plus the EXIF offset', () => {
    expect(capturedInstant(photo('2026-11-01T03:00:00', at(0)))).toBe(T0);
    expect(capturedInstant(photo('2026-11-01T12:00:00', at(0), '+02:00'))).toBe(T0);
    expect(capturedInstant(photo('2026-11-01T03:00:00', at(0), ''))).toBeUndefined();
    expect(capturedInstant(photo('2026-11-01T03:00:00', at(0), 'PDT'))).toBeUndefined();
  });

  it('keeps photos that waited at least 10 minutes, drops ones synced while shooting', () => {
    const uploads = backlogUploads([
      photo('2026-11-01T03:00:00', at(30 * 1000)), // live: 30 s after the shot
      photo('2026-11-01T03:00:00', at(LIVE_MS - 1)), // live, just
      photo('2026-11-01T03:00:00', at(LIVE_MS)), // waited 10 min: counts
      photo('2026-10-24T11:21:00', at(0)), // last week's shoot, synced now
    ]);
    expect(uploads).toEqual([at(LIVE_MS), at(0)]);
  });

  it('counts a photo whose capture instant is unknown, so nothing is silently missed', () => {
    expect(backlogUploads([photo('2026-11-01T03:00:00', at(0), '')])).toEqual([at(0)]);
  });

  it('a live shoot never starts a burst; the batch synced later does', async () => {
    const devices = createMemoryDeviceStore([phone]);
    const push = okPush();
    const deps = { store: fakeStore(), devices, push, later: later(), now: () => new Date(T0), log: quiet };
    const insertOf = (capturedAt: string, uploadedAt: string) => ({
      eventSource: 'aws:dynamodb',
      eventName: 'INSERT',
      dynamodb: { NewImage: marshall(item('x', 'unreviewed', { capturedAt, capturedOffset: '-07:00', uploadedAt })) },
    });
    const handle = createNotifierHandler(async () => deps);
    await handle({ Records: [insertOf('2026-11-01T03:00:00', at(20 * 1000)), insertOf('2026-11-01T03:01:00', at(80 * 1000))] } as unknown as DynamoDBStreamEvent);
    expect(push).not.toHaveBeenCalled();
    expect(devices.burst).toBeUndefined();
    await handle({ Records: [insertOf('2026-11-01T02:00:00', at(0))] } as unknown as DynamoDBStreamEvent);
    expect(push).toHaveBeenCalledWith([TOKEN_A], syncingPayload());
  });
});

describe('weekly reminder at a random day and time', () => {
  const NY = 'America/New_York';
  const fixed = (...vals: number[]) => {
    let i = 0;
    return () => vals[i++ % vals.length]!;
  };

  it('turns a wall-clock time in a zone into UTC, across daylight saving', () => {
    expect(new Date(zonedTimeToUtc(2026, 11, 8, 9, 0, NY)).toISOString()).toBe('2026-11-08T14:00:00.000Z'); // EST
    expect(new Date(zonedTimeToUtc(2026, 7, 8, 9, 0, NY)).toISOString()).toBe('2026-07-08T13:00:00.000Z'); // EDT
    expect(new Date(zonedTimeToUtc(2026, 11, 8, 9, 0, 'Europe/Berlin')).toISOString()).toBe('2026-11-08T08:00:00.000Z');
  });

  it('picks 4 to 10 days later, between 9:00 and 21:00 local', () => {
    const now = new Date('2026-11-02T03:00:00Z'); // Nov 1, 22:00 in New York
    expect(nextReminderAt(now, NY, fixed(0, 0))).toBe('2026-11-05T14:00:00.000Z'); // Nov 5, 09:00 EST
    expect(nextReminderAt(now, NY, fixed(0.9999, 0.9999))).toBe('2026-11-12T01:59:00.000Z'); // Nov 11, 20:59 EST
    for (let i = 0; i < 200; i++) {
      const t = Date.parse(nextReminderAt(now, NY));
      const local = new Intl.DateTimeFormat('en-US', { timeZone: NY, hourCycle: 'h23', hour: 'numeric' }).format(new Date(t));
      expect(Number(local)).toBeGreaterThanOrEqual(REMINDER_WINDOW.fromHour);
      expect(Number(local)).toBeLessThan(REMINDER_WINDOW.toHour);
      expect(t - now.getTime()).toBeGreaterThan(3 * 86400_000);
      expect(t - now.getTime()).toBeLessThan(11 * 86400_000);
    }
  });

  const tick = (devices: ReturnType<typeof createMemoryDeviceStore>, push: PushFn | null, now: number, store = fakeStore()) =>
    onReminderTick({ store, devices, push, later: later(), timeZone: NY, rand: fixed(0.5, 0.5), now: () => new Date(now), log: quiet });

  it('first run only schedules; before it is due nothing happens; when due it reminds and reschedules', async () => {
    const devices = createMemoryDeviceStore([phone]);
    const push = okPush();
    const first = await tick(devices, push, T0);
    expect(first.action).toBe('scheduled');
    const due = Date.parse(devices.reminderAt!);
    expect(await tick(devices, push, due - 60_000)).toMatchObject({ action: 'wait' });
    expect(push).not.toHaveBeenCalled();
    // fakeStore counts 5 unreviewed.
    expect(await tick(devices, push, due + 60_000)).toMatchObject({ action: 'sent', unreviewed: 5, delivered: 1 });
    expect(push).toHaveBeenCalledWith([TOKEN_A], reminderPayload(5));
    expect(reminderPayload(5).aps).toMatchObject({ alert: { body: '5 photos waiting to review.' }, badge: 5 });
    expect(reminderPayload(1).aps.alert?.body).toBe('1 photo waiting to review.');
    expect(Date.parse(devices.reminderAt!)).toBeGreaterThan(due + 3 * 86400_000);
    // The next tick, a quarter hour later, does not send again.
    expect(await tick(devices, push, due + 16 * 60_000)).toMatchObject({ action: 'wait' });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('skips phones that turned reminders off, and says nothing when Review is empty', async () => {
    const devices = createMemoryDeviceStore([phone, { token: TOKEN_B, platform: 'ios', registeredAt: at(0), reminders: false }], undefined, at(0));
    const push = okPush();
    await tick(devices, push, T0 + 1);
    expect(push).toHaveBeenCalledWith([TOKEN_A], expect.anything());

    const empty = fakeStore();
    empty.countByStatus = vi.fn(async () => 0);
    const quietDevices = createMemoryDeviceStore([phone], undefined, at(0));
    const push2 = okPush();
    expect(await tick(quietDevices, push2, T0 + 1, empty)).toMatchObject({ action: 'skipped', unreviewed: 0 });
    expect(push2).not.toHaveBeenCalled();
    expect(quietDevices.reminderAt).not.toBe(at(0)); // still moves on to next week
  });

  it('the handler routes the schedule tick to it', async () => {
    const push = okPush();
    const devices = createMemoryDeviceStore([phone], undefined, at(-60_000));
    const handle = createNotifierHandler(async () => ({ store: fakeStore(), devices, push, later: later(), log: quiet }));
    await handle({ kind: 'reminder' });
    expect(push.mock.calls[0]![1].kind).toBe('reminder');
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
    expect(body(r)).toEqual({ configured: false, devices: 1, reminders: true });
    expect(devices.devices[0]).toMatchObject({ token: TOKEN_A, name: 'iPhone', platform: 'ios' });
    // Registering again is a refresh, not a second device.
    await app(ev('POST /devices', { body: JSON.stringify({ token: TOKEN_A }) }));
    expect(devices.devices).toHaveLength(1);
  });

  it('turns the weekly reminder off and on for one phone, and a plain launch keeps the choice', async () => {
    const { devices, app } = setup();
    expect(body(await app(ev('POST /devices', { body: JSON.stringify({ token: TOKEN_A, reminders: false }) }))).reminders).toBe(false);
    expect(body(await app(ev('POST /devices', { body: JSON.stringify({ token: TOKEN_A }) }))).reminders).toBe(false);
    expect(devices.devices[0]!.reminders).toBe(false);
    expect(body(await app(ev('POST /devices', { body: JSON.stringify({ token: TOKEN_A, reminders: true }) }))).reminders).toBe(true);
    expect((await app(ev('POST /devices', { body: JSON.stringify({ token: TOKEN_A, reminders: 'no' }) }))).statusCode).toBe(400);
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

  it('registering updates in place and only touches reminders when asked', async () => {
    const { ddb, inputs } = fake(() => ({ Attributes: { platform: 'ios', registeredAt: at(0), reminders: false } }));
    const store = createDynamoDeviceStore('n', ddb);
    expect(await store.register(TOKEN_A, {}, at(0))).toMatchObject({ reminders: false });
    expect(inputs[0]).toMatchObject({ UpdateExpression: 'SET #t = :t, platform = :p, registeredAt = :now', ReturnValues: 'ALL_NEW' });
    await store.register(TOKEN_A, { name: 'iPhone', reminders: true }, at(0));
    expect(inputs[1]!.UpdateExpression).toBe('SET #t = :t, platform = :p, registeredAt = :now, #n = :n, reminders = :r');
  });

  it('only one run can move the reminder on', async () => {
    const { ddb, inputs } = fake(() => ({}));
    expect(await createDynamoDeviceStore('n', ddb).advanceReminder(at(0), at(7 * 86400_000))).toBe(true);
    expect(inputs[0]).toMatchObject({ ConditionExpression: 'nextAt = :cur', ExpressionAttributeValues: { ':next': at(7 * 86400_000), ':cur': at(0) } });
    await createDynamoDeviceStore('n', ddb).advanceReminder(undefined, at(0));
    expect(inputs[1]!.ConditionExpression).toBe('attribute_not_exists(nextAt)');
    const lost = fake(() => {
      throw Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' });
    });
    expect(await createDynamoDeviceStore('n', lost.ddb).advanceReminder(at(0), at(1))).toBe(false);
  });

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
