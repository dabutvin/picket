/**
 * Push notifications for photos syncing from the camera (ADR-010). Two per burst:
 *
 *   1. "Photos are syncing" as soon as the first new photo of a burst lands, and
 *   2. "Done: N new photos synced" once nothing new has arrived for QUIET_MS.
 *
 * Live transfer doesn't count: a photo synced less than LIVE_MS after it was taken means the
 * camera is sending while you shoot, and you're holding it. Only photos that waited (a batch after
 * the shoot) start or extend a burst.
 * Event-driven, nothing polls: the Photos table stream (INSERT only, so a re-sent frame never
 * counts) calls `onUploads`, which starts or extends the burst and drops a message on a delay
 * queue. Each message comes due QUIET_MS after its photo and calls `onQuiet`; only the one that
 * finds no newer upload since it was sent closes the burst and sends "done".
 *
 * Phones register their APNs device token with POST /devices; pushes go straight to Apple (no
 * Expo push service). State lives in the small Notify table: one row per device
 * (`device#<token>`) and one `burst` row while photos are arriving.
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Store } from './store.js';
import type { PhotoItem } from './types.js';

// ----------------------------------------------------------------------------- devices + burst state

export interface Device {
  token: string;
  platform: 'ios';
  /** Shown nowhere yet; handy when reading the table. */
  name?: string;
  registeredAt: string;
}

/** Photos arriving right now. Absent between bursts. */
export interface Burst {
  startedAt: string;
  /** uploadedAt of the newest photo so far; the delay-queue messages carry the value they saw. */
  lastUploadAt: string;
  count: number;
}

export interface DeviceStore {
  list(): Promise<Device[]>;
  put(device: Device): Promise<void>;
  remove(token: string): Promise<void>;
  /** Add `count` photos, the newest uploaded at `lastUploadAt`. `started` is true for exactly one caller per burst. */
  noteUploads(count: number, lastUploadAt: string, now: string): Promise<{ started: boolean }>;
  getBurst(): Promise<Burst | undefined>;
  /** End the burst only if no photo arrived after `lastUploadAt`; the closed burst, or undefined if it moved on (or another call closed it). */
  closeBurst(lastUploadAt: string): Promise<Burst | undefined>;
}

const DEVICE = 'device#';
const BURST = { pk: 'burst', sk: 'burst' };

const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export function createDynamoDeviceStore(tableName: string, ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })): DeviceStore {
  return {
    async list() {
      // One user, a handful of phones: a query on the fixed partition is all it takes.
      const res = await ddb.send(
        new QueryCommand({ TableName: tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'devices' } }),
      );
      return (res.Items ?? []).map(({ token, platform, name, registeredAt }) => ({ token, platform, name, registeredAt }) as Device);
    },
    async put(device) {
      await ddb.send(new PutCommand({ TableName: tableName, Item: { pk: 'devices', sk: `${DEVICE}${device.token}`, ...device } }));
    },
    async remove(token) {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: { pk: 'devices', sk: `${DEVICE}${token}` } }));
    },
    async noteUploads(count, lastUploadAt, now) {
      // One atomic write: the caller that finds no startedAt is the one that started the burst.
      const res = await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: BURST,
          UpdateExpression: 'SET startedAt = if_not_exists(startedAt, :now), lastUploadAt = :last ADD #c :n',
          ExpressionAttributeNames: { '#c': 'count' },
          ExpressionAttributeValues: { ':now': now, ':last': lastUploadAt, ':n': count },
          // Old values of the attributes this write touched: no startedAt means there was no burst.
          ReturnValues: 'UPDATED_OLD',
        }),
      );
      return { started: !(res.Attributes as Partial<Burst> | undefined)?.startedAt };
    },
    async getBurst() {
      const res = await ddb.send(new GetCommand({ TableName: tableName, Key: BURST }));
      return res.Item as Burst | undefined;
    },
    async closeBurst(lastUploadAt) {
      try {
        const res = await ddb.send(
          new DeleteCommand({
            TableName: tableName,
            Key: BURST,
            ConditionExpression: 'lastUploadAt = :last',
            ExpressionAttributeValues: { ':last': lastUploadAt },
            ReturnValues: 'ALL_OLD',
          }),
        );
        return res.Attributes as Burst | undefined;
      } catch (err) {
        if (isConditionFailure(err)) return undefined;
        throw err;
      }
    },
  };
}

export function createMemoryDeviceStore(devices: Device[] = [], burst?: Burst): DeviceStore & { devices: Device[]; burst: Burst | undefined } {
  const s: { devices: Device[]; burst: Burst | undefined } = { devices: [...devices], burst: burst && { ...burst } };
  return {
    get devices() {
      return s.devices;
    },
    get burst() {
      return s.burst;
    },
    list: async () => [...s.devices],
    put: async (d) => {
      s.devices = [...s.devices.filter((x) => x.token !== d.token), d];
    },
    remove: async (token) => {
      s.devices = s.devices.filter((x) => x.token !== token);
    },
    noteUploads: async (count, lastUploadAt, now) => {
      const started = !s.burst;
      s.burst = { startedAt: s.burst?.startedAt ?? now, lastUploadAt, count: (s.burst?.count ?? 0) + count };
      return { started };
    },
    getBurst: async () => s.burst && { ...s.burst },
    closeBurst: async (lastUploadAt) => {
      if (!s.burst || s.burst.lastUploadAt !== lastUploadAt) return undefined;
      const closed = s.burst;
      s.burst = undefined;
      return closed;
    },
  };
}

/** APNs device tokens are 32 bytes, sent as 64 hex characters (longer ones are allowed for the future). */
export const isDeviceToken = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64,200}$/i.test(v);

// ----------------------------------------------------------------------------- APNs

export interface ApnsKey {
  keyId: string;
  teamId: string;
  /** Contents of the AuthKey_<keyId>.p8 file. */
  p8: string;
}

export interface ApnsPayload {
  aps: { alert?: { title?: string; body: string }; badge?: number; sound?: string; 'thread-id'?: string };
  [key: string]: unknown;
}

export type PushResult = { token: string; ok: true } | { token: string; ok: false; status: number; reason: string; gone: boolean };

export type PushFn = (tokens: string[], payload: ApnsPayload) => Promise<PushResult[]>;

/** Accept the .p8 as pasted: raw PEM, PEM with literal "\n" sequences, or base64 of the file. */
export function normalizeP8(raw: string): string {
  let s = raw.trim();
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  if (!s.includes('BEGIN')) {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) s = decoded;
  }
  return s.endsWith('\n') ? s : `${s}\n`;
}

/** Provider token for APNs: ES256 JWT, valid for up to an hour (Apple asks for at most one new one every 20 min). */
export function apnsJwt(key: ApnsKey, now = Date.now()): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${b64({ alg: 'ES256', kid: key.keyId })}.${b64({ iss: key.teamId, iat: Math.floor(now / 1000) })}`;
  const signature = sign('sha256', Buffer.from(data), { key: createPrivateKey(normalizeP8(key.p8)), dsaEncoding: 'ieee-p1363' });
  return `${data}.${signature.toString('base64url')}`;
}

/**
 * TestFlight and ad hoc builds talk to production APNs; only a debug build from Xcode would need
 * the sandbox host.
 */
export const APNS_HOST = 'https://api.push.apple.com';

export function createApnsPush(key: ApnsKey, topic: string, host = APNS_HOST): PushFn {
  let jwt: { value: string; at: number } | undefined;
  const bearer = () => {
    if (!jwt || Date.now() - jwt.at > 40 * 60_000) jwt = { value: apnsJwt(key), at: Date.now() };
    return jwt.value;
  };
  return async (tokens, payload) => {
    if (tokens.length === 0) return [];
    const session: ClientHttp2Session = connect(host);
    session.on('error', () => undefined); // surfaced per request below
    const body = JSON.stringify(payload);
    try {
      return await Promise.all(
        tokens.map(
          (token) =>
            new Promise<PushResult>((resolve) => {
              const req = session.request({
                [constants.HTTP2_HEADER_METHOD]: 'POST',
                [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
                authorization: `bearer ${bearer()}`,
                'apns-topic': topic,
                'apns-push-type': 'alert',
                'apns-priority': '10',
                'content-type': 'application/json',
              });
              let status = 0;
              let text = '';
              req.setEncoding('utf8');
              req.on('response', (h) => {
                status = Number(h[constants.HTTP2_HEADER_STATUS]);
              });
              req.on('data', (chunk: string) => (text += chunk));
              req.on('end', () => resolve(pushResult(token, status, text)));
              req.on('error', (err: Error) => resolve({ token, ok: false, status: 0, reason: err.message, gone: false }));
              req.end(body);
            }),
        ),
      );
    } finally {
      session.close();
    }
  };
}

/** 410, or a 400 saying the token is bad, means the app was deleted or the token belongs elsewhere: forget it. */
export function pushResult(token: string, status: number, text: string): PushResult {
  if (status === 200) return { token, ok: true };
  let reason = text || `HTTP ${status}`;
  try {
    reason = (JSON.parse(text) as { reason?: string }).reason ?? reason;
  } catch {
    /* keep raw text */
  }
  const gone = status === 410 || (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'));
  return { token, ok: false, status, reason, gone };
}

/** The APNs key secret holds `{keyId, teamId, p8}`; `{}` until the deploy workflow fills it. */
export async function loadApnsKey(secretId: string, client = new SecretsManagerClient({})): Promise<ApnsKey | null> {
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const parsed = JSON.parse(res.SecretString || '{}') as Partial<ApnsKey>;
  return parsed.keyId && parsed.teamId && parsed.p8 ? (parsed as ApnsKey) : null;
}

// ----------------------------------------------------------------------------- what counts

/** Synced within this long of being taken = live transfer while shooting: no notifications. */
export const LIVE_MS = 10 * 60_000;

/** The instant a photo was taken: camera-local capturedAt plus the camera's offset. Undefined if either is missing. */
export function capturedInstant(p: Pick<PhotoItem, 'capturedAt' | 'capturedOffset'>): number | undefined {
  if (!p.capturedAt || !p.capturedOffset || !/^[+-]\d{2}:\d{2}$/.test(p.capturedOffset)) return undefined;
  const t = Date.parse(`${p.capturedAt.slice(0, 19)}${p.capturedOffset}`);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * uploadedAt of the photos that count: those that reached S3 at least LIVE_MS after they were
 * taken. A photo whose capture instant is unknown (no offset in its EXIF) counts, so nothing is
 * silently missed.
 */
export function backlogUploads(rows: Pick<PhotoItem, 'uploadedAt' | 'capturedAt' | 'capturedOffset'>[]): string[] {
  return rows
    .filter((p) => {
      const taken = capturedInstant(p);
      return taken === undefined || Date.parse(p.uploadedAt) - taken >= LIVE_MS;
    })
    .map((p) => p.uploadedAt);
}

// ----------------------------------------------------------------------------- when to notify

/**
 * A burst is over once nothing new has arrived for this long. Batches arrive one photo every
 * 2–25 s and separate batches were at least 15 min apart (ops → sync-history), so 3 min splits
 * them the same as anything up to 15 and keeps "done" prompt. Live shooting, whose pauses are
 * longer, never gets here (LIVE_MS).
 */
export const QUIET_MS = 3 * 60_000;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function syncingPayload(): ApnsPayload {
  return {
    aps: { alert: { title: 'Picket', body: 'Photos are syncing from the camera…' }, sound: 'default', 'thread-id': 'sync' },
    kind: 'syncing',
  };
}

export function donePayload(count: number, unreviewed: number): ApnsPayload {
  return {
    aps: {
      alert: { title: 'Picket', body: `Done: ${plural(count, 'new photo')} synced. ${unreviewed} to review.` },
      badge: unreviewed,
      sound: 'default',
      'thread-id': 'sync',
    },
    kind: 'done',
  };
}

export interface NotifierDeps {
  store: Store;
  devices: DeviceStore;
  /** Null when the APNs key isn't configured yet: bursts are still tracked, nothing is sent. */
  push: PushFn | null;
  /** Schedule `onQuiet(lastUploadAt)` QUIET_MS from now (an SQS message with DelaySeconds). */
  later: (lastUploadAt: string) => Promise<void>;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

/** Prune tokens Apple says are dead; report how many pushes landed. */
async function deliver(devices: DeviceStore, push: PushFn, payload: ApnsPayload, log: NonNullable<NotifierDeps['log']>) {
  const tokens = (await devices.list()).map((d) => d.token);
  const results = await push(tokens, payload);
  let removed = 0;
  for (const r of results) {
    if (r.ok) continue;
    log('push failed', { token: `${r.token.slice(0, 8)}…`, status: r.status, reason: r.reason });
    if (r.gone) {
      await devices.remove(r.token);
      removed++;
    }
  }
  return { delivered: results.filter((r) => r.ok).length, attempted: tokens.length, removed };
}

const latest = (times: string[]) => times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));

/** New photos landed (uploadedAt of each). Starts or extends the burst; the first one of a burst says "syncing". */
export async function onUploads(uploads: string[], { devices, push, later, now = () => new Date(), log = console.log }: NotifierDeps) {
  if (uploads.length === 0) return { started: false };
  const last = latest(uploads);
  const at = now();
  // A burst whose closing message never came (a lost or failed delivery) must not swallow the next
  // shoot's "syncing": past its quiet time, close it silently and start over.
  const open = await devices.getBurst();
  if (open && at.getTime() - Date.parse(open.lastUploadAt) > 2 * QUIET_MS) {
    log('closing a stale burst', open);
    await devices.closeBurst(open.lastUploadAt);
  }
  const { started } = await devices.noteUploads(uploads.length, last, at.toISOString());
  if (started && push) await deliver(devices, push, syncingPayload(), log);
  await later(last);
  return { started };
}

/**
 * A delay-queue message came due. If a newer photo arrived since it was sent, its own message will
 * come later: do nothing. Otherwise the burst is over: close it (exactly once) and say "done".
 */
export async function onQuiet(lastUploadAt: string, { store, devices, push, log = console.log }: NotifierDeps) {
  const closed = await devices.closeBurst(lastUploadAt);
  if (!closed) return { done: false as const };
  if (!push) {
    log('APNs key not configured; burst closed without a push', { count: closed.count });
    return { done: true as const, count: closed.count };
  }
  const unreviewed = await store.countByStatus('unreviewed');
  const sent = await deliver(devices, push, donePayload(closed.count, unreviewed), log);
  return { done: true as const, count: closed.count, ...sent };
}

/** What the API's routes need: register a phone, forget one, send a test push. */
export interface NotificationService {
  configured(): Promise<boolean>;
  register(token: string, name?: string): Promise<{ configured: boolean; devices: number }>;
  unregister(token: string): Promise<void>;
  test(): Promise<{ configured: boolean; attempted: number; delivered: number; removed: number }>;
}

export function createNotificationService(devices: DeviceStore, push: () => Promise<PushFn | null>, log: NotifierDeps['log'] = console.log): NotificationService {
  return {
    async configured() {
      return (await push()) !== null;
    },
    async register(token, name) {
      await devices.put({ token, platform: 'ios', name, registeredAt: new Date().toISOString() });
      return { configured: (await push()) !== null, devices: (await devices.list()).length };
    },
    unregister: (token) => devices.remove(token),
    async test() {
      const fn = await push();
      if (!fn) return { configured: false, attempted: 0, delivered: 0, removed: 0 };
      const payload: ApnsPayload = { aps: { alert: { title: 'Picket', body: 'Notifications are on. You will hear about new photos here.' }, sound: 'default' }, kind: 'test' };
      return { configured: true, ...(await deliver(devices, fn, payload, log)) };
    },
  };
}
