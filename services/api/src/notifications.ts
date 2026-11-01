/**
 * Push notifications for newly synced photos (ADR-010).
 *
 * Phones register their APNs device token with POST /devices. Every few minutes the notifier
 * Lambda looks at the unreviewed photos, and once a burst from the camera has gone quiet it sends
 * one "N new photos to review" push to every registered phone, straight to Apple (no Expo push
 * service). The badge is the whole unreviewed count.
 *
 * State lives in the small Notify table: one row per device (`device#<token>`) and one `state`
 * row holding the watermark (uploadedAt of the newest photo already announced).
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Store } from './store.js';

// ----------------------------------------------------------------------------- devices + state

export interface Device {
  token: string;
  platform: 'ios';
  /** Shown nowhere yet; handy when reading the table. */
  name?: string;
  registeredAt: string;
}

export interface NotifyState {
  /** uploadedAt of the newest photo already announced (or, on the first run, when notifications started). */
  watermark?: string;
  lastSentAt?: string;
  lastCount?: number;
}

export interface DeviceStore {
  list(): Promise<Device[]>;
  put(device: Device): Promise<void>;
  remove(token: string): Promise<void>;
  getState(): Promise<NotifyState>;
  putState(state: NotifyState): Promise<void>;
}

const DEVICE = 'device#';
const STATE = 'state';

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
    async getState() {
      const res = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk: STATE, sk: STATE } }));
      const { watermark, lastSentAt, lastCount } = (res.Item ?? {}) as NotifyState;
      return { watermark, lastSentAt, lastCount };
    },
    async putState(state) {
      await ddb.send(new PutCommand({ TableName: tableName, Item: { pk: STATE, sk: STATE, ...state } }));
    },
  };
}

export function createMemoryDeviceStore(devices: Device[] = [], state: NotifyState = {}): DeviceStore & { devices: Device[]; state: NotifyState } {
  const s = { devices: [...devices], state: { ...state } };
  return {
    get devices() {
      return s.devices;
    },
    get state() {
      return s.state;
    },
    list: async () => [...s.devices],
    put: async (d) => {
      s.devices = [...s.devices.filter((x) => x.token !== d.token), d];
    },
    remove: async (token) => {
      s.devices = s.devices.filter((x) => x.token !== token);
    },
    getState: async () => ({ ...s.state }),
    putState: async (st) => {
      s.state = { ...st };
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

// ----------------------------------------------------------------------------- when to notify

/** A burst is over once nothing new has arrived for this long. */
export const QUIET_MS = 3 * 60_000;
/** During a long shoot, still say something this often. */
export const MAX_WAIT_MS = 30 * 60_000;

export type Plan = { action: 'none' } | { action: 'start'; watermark: string } | { action: 'wait' } | { action: 'send'; count: number; watermark: string };

/**
 * Pure decision. `uploads` are the uploadedAt times of the photos that are unreviewed right now,
 * so anything already decided in the app never counts. The first run sets the watermark to now
 * and announces nothing, so turning notifications on doesn't announce the existing backlog.
 */
export function planNotification(watermark: string | undefined, uploads: string[], now: Date): Plan {
  if (!watermark) return { action: 'start', watermark: now.toISOString() };
  // Compare as instants: S3 event times and the preview Lambda's fallback format differ as strings.
  const mark = Date.parse(watermark);
  const fresh = uploads
    .map(Date.parse)
    .filter((t) => Number.isFinite(t) && t > mark)
    .sort((a, b) => a - b);
  if (fresh.length === 0) return { action: 'none' };
  const oldest = fresh[0]!;
  const newest = fresh[fresh.length - 1]!;
  const quiet = now.getTime() - newest >= QUIET_MS;
  const overdue = now.getTime() - oldest >= MAX_WAIT_MS;
  if (!quiet && !overdue) return { action: 'wait' };
  return { action: 'send', count: fresh.length, watermark: new Date(newest).toISOString() };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function newPhotosPayload(count: number, unreviewed: number): ApnsPayload {
  return {
    aps: {
      alert: { title: 'Picket', body: `${plural(count, 'new photo')} to review` },
      badge: unreviewed,
      sound: 'default',
      'thread-id': 'new-photos',
    },
    kind: 'new-photos',
  };
}

/** Every unreviewed photo's uploadedAt, paging through the byStatus index. */
export async function unreviewedUploads(store: Store): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listByStatus('unreviewed', 100, cursor);
    for (const p of page.items) if (p.uploadedAt) out.push(p.uploadedAt);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

export interface NotifierDeps {
  store: Store;
  devices: DeviceStore;
  /** Null when the APNs key isn't configured yet: the notifier keeps its watermark moving and sends nothing. */
  push: PushFn | null;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
}

export type NotifierOutcome = Plan & { delivered?: number; removed?: number };

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

export async function runNotifier({ store, devices, push, now = () => new Date(), log = console.log }: NotifierDeps): Promise<NotifierOutcome> {
  const state = await devices.getState();
  const uploads = await unreviewedUploads(store);
  const at = now();
  const plan = planNotification(state.watermark, uploads, at);
  if (plan.action === 'start') {
    await devices.putState({ ...state, watermark: plan.watermark });
    return plan;
  }
  if (plan.action !== 'send') return plan;
  if (!push) {
    log('APNs key not configured; skipping', { count: plan.count });
    await devices.putState({ ...state, watermark: plan.watermark });
    return plan;
  }
  const { delivered, removed } = await deliver(devices, push, newPhotosPayload(plan.count, uploads.length), log);
  await devices.putState({ watermark: plan.watermark, lastSentAt: at.toISOString(), lastCount: plan.count });
  return { ...plan, delivered, removed };
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
