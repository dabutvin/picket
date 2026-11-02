/**
 * Push notifications for photos syncing from the camera (ADR-010): one "Photos are syncing" push
 * when photos start arriving, and nothing more until that one has been seen.
 *
 * The server can't see a phone's lock screen, so each phone keeps two times: `notifiedAt` (the
 * last syncing push) and `openedAt` (the last time the app came to the foreground, which also
 * clears Picket's notifications). A phone is notified only when `notifiedAt` is not after
 * `openedAt`, claimed with a conditional write so concurrent batches send it once. A batch, or a
 * live shoot that trickles in for an hour, therefore gives one push; the next push comes on the
 * first new photo after the app has been opened. Every push also uses one APNs collapse id, so if
 * two ever overlap the newer replaces the older instead of stacking.
 *
 * Event-driven: the notifier reads the Photos table stream filtered to INSERT (a re-sent frame is
 * a MODIFY and never counts). Pushes go straight to Apple, no Expo push service. Phones register
 * (and say "opened") with POST /devices.
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Store } from './store.js';

// ----------------------------------------------------------------------------- devices

export interface Device {
  token: string;
  platform: 'ios';
  /** Shown nowhere yet; handy when reading the table. */
  name?: string;
  /** Last time the app came to the foreground (and cleared its notifications). */
  openedAt: string;
  /** Last "syncing" push. Newer than openedAt means it is still unread: don't notify again. */
  notifiedAt?: string;
}

/** Still holding an unread syncing notification. */
export const pending = (d: Pick<Device, 'openedAt' | 'notifiedAt'>) => !!d.notifiedAt && d.notifiedAt > d.openedAt;

export interface DeviceStore {
  list(): Promise<Device[]>;
  /** Register a phone or record that the app was opened (both re-arm notifications). */
  opened(token: string, name: string | undefined, now: string): Promise<void>;
  remove(token: string): Promise<void>;
  /** Mark a phone notified unless it already holds an unread push; true if this call claimed it. */
  claim(token: string, now: string): Promise<boolean>;
}

const DEVICES = 'devices';
const key = (token: string) => ({ pk: DEVICES, sk: `device#${token}` });
const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export function createDynamoDeviceStore(tableName: string, ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } })): DeviceStore {
  return {
    async list() {
      // One user, a handful of phones: a query on the fixed partition is all it takes.
      const res = await ddb.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': DEVICES } }));
      return (res.Items ?? []).map(({ token, platform, name, openedAt, notifiedAt }) => ({ token, platform, name, openedAt, notifiedAt }) as Device);
    },
    async opened(token, name, now) {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key(token),
          UpdateExpression: 'SET #t = :t, platform = :p, openedAt = :now' + (name ? ', #n = :n' : ''),
          ExpressionAttributeNames: { '#t': 'token', ...(name ? { '#n': 'name' } : {}) },
          ExpressionAttributeValues: { ':t': token, ':p': 'ios', ':now': now, ...(name ? { ':n': name } : {}) },
        }),
      );
    },
    async remove(token) {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: key(token) }));
    },
    async claim(token, now) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: tableName,
            Key: key(token),
            UpdateExpression: 'SET notifiedAt = :now',
            // Exists, and holds no unread push (never notified, or opened since the last one).
            ConditionExpression: 'attribute_exists(sk) AND (attribute_not_exists(notifiedAt) OR notifiedAt <= openedAt)',
            ExpressionAttributeValues: { ':now': now },
          }),
        );
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },
  };
}

export function createMemoryDeviceStore(devices: Device[] = []): DeviceStore & { devices: Device[] } {
  const s = { devices: devices.map((d) => ({ ...d })) };
  return {
    get devices() {
      return s.devices;
    },
    list: async () => s.devices.map((d) => ({ ...d })),
    opened: async (token, name, now) => {
      const old = s.devices.find((d) => d.token === token);
      s.devices = [...s.devices.filter((d) => d.token !== token), { ...old, token, platform: 'ios', name: name ?? old?.name, openedAt: now }];
    },
    remove: async (token) => {
      s.devices = s.devices.filter((d) => d.token !== token);
    },
    claim: async (token, now) => {
      const d = s.devices.find((x) => x.token === token);
      if (!d || pending(d)) return false;
      d.notifiedAt = now;
      return true;
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

export type PushFn = (tokens: string[], payload: ApnsPayload, opts?: { collapseId?: string }) => Promise<PushResult[]>;

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
  return async (tokens, payload, opts = {}) => {
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
                ...(opts.collapseId ? { 'apns-collapse-id': opts.collapseId } : {}),
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

// ----------------------------------------------------------------------------- when to notify

/** Every Picket push shares this collapse id: a newer one replaces an older one on the phone. */
export const COLLAPSE_ID = 'picket-sync';

export function syncingPayload(unreviewed: number): ApnsPayload {
  return {
    aps: { alert: { title: 'Picket', body: 'New photos are syncing from your camera.' }, badge: unreviewed, sound: 'default', 'thread-id': 'sync' },
    kind: 'syncing',
  };
}

export interface NotifierDeps {
  store: Store;
  devices: DeviceStore;
  /** Null when the APNs key isn't configured yet: nothing is claimed or sent. */
  push: PushFn | null;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

/** Send to `tokens`; forget tokens Apple says are dead; report how many pushes landed. */
async function deliver(devices: DeviceStore, push: PushFn, tokens: string[], payload: ApnsPayload, log: NonNullable<NotifierDeps['log']>) {
  const results = await push(tokens, payload, { collapseId: COLLAPSE_ID });
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

/**
 * `count` new photos landed. Every phone without an unread push gets "syncing"; phones that
 * already have one are left alone until the app is opened.
 */
export async function onUploads(count: number, { store, devices, push, now = () => new Date(), log = console.log }: NotifierDeps) {
  if (count === 0 || !push) return { notified: 0 };
  const at = now().toISOString();
  const due = (await devices.list()).filter((d) => !pending(d));
  const claimed: string[] = [];
  for (const d of due) if (await devices.claim(d.token, at)) claimed.push(d.token);
  if (claimed.length === 0) return { notified: 0 };
  const sent = await deliver(devices, push, claimed, syncingPayload(await store.countByStatus('unreviewed')), log);
  return { notified: sent.delivered, ...sent };
}

/** What the API's routes need: register (or say "opened"), forget a phone, send a test push. */
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
      await devices.opened(token, name, new Date().toISOString());
      return { configured: (await push()) !== null, devices: (await devices.list()).length };
    },
    unregister: (token) => devices.remove(token),
    async test() {
      const fn = await push();
      if (!fn) return { configured: false, attempted: 0, delivered: 0, removed: 0 };
      const payload: ApnsPayload = { aps: { alert: { title: 'Picket', body: 'Notifications are on. You will hear when new photos start syncing.' }, sound: 'default' }, kind: 'test' };
      const tokens = (await devices.list()).map((d) => d.token);
      return { configured: true, ...(await deliver(devices, fn, tokens, payload, log ?? console.log)) };
    },
  };
}
