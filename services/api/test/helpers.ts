import { vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createMemoryConnectionStore } from '../src/connection.js';
import { BadCursor, type Store } from '../src/store.js';
import type { LightroomConnection, LightroomStatus, PhotoItem, PhotoStatus } from '../src/types.js';
import type { AppDeps } from '../src/app.js';
import { createReceiverService, type ReceiverCloud, type ReceiverConfig } from '../src/receiver.js';

export const item = (id: string, status: PhotoItem['status'] = 'unreviewed', extra: Partial<PhotoItem> = {}): PhotoItem => ({
  photoId: id,
  status,
  capturedAt: '2026-10-30T10:00:00',
  uploadedAt: '2026-10-30T10:01:00Z',
  rawKey: `raw/2026/10/30/${id}.ARW`,
  fileName: `${id}.ARW`,
  previewKey: `previews/${id}.jpg`,
  thumbKey: `thumbs/${id}.jpg`,
  bytes: 123,
  ...extra,
});

export const fakeStore = (): Store => ({
  listByStatus: vi.fn(async (status, limit, cursor) => {
    if (cursor === 'bad') throw new BadCursor();
    return { items: [item('a', status), item('b', status)].slice(0, limit), cursor: limit < 2 ? 'next' : undefined };
  }),
  get: vi.fn(async (id) => (id === 'a' ? item('a') : undefined)),
  setStatus: vi.fn(async (id, status) => (id === 'a' ? item('a', status) : undefined)),
  setLightroom: vi.fn(async (id, info) => (id === 'a' ? item('a', 'pick', { lightroomStatus: info.status, lightroom: info }) : undefined)),
  requeueLightroom: vi.fn(async (id) => (id === 'a' ? item('a', 'pick', { lightroomStatus: 'queued' }) : undefined)),
  countByStatus: vi.fn(async (status: PhotoStatus) => ({ unreviewed: 5, pick: 2, reject: 7 })[status]),
  countByLightroomStatus: vi.fn(async (status: LightroomStatus) => ({ queued: 1, uploading: 0, done: 1, duplicate: 0, failed: 0 })[status]),
  signGet: vi.fn(async (key, ttl) => `https://s3/${key}?ttl=${ttl}`),
});

export const connection = (extra: Partial<LightroomConnection> = {}): LightroomConnection => ({
  refreshToken: 'rt',
  accessToken: 'at',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  catalogId: 'cat1',
  accountId: 'acct1',
  email: 'dan@example.com',
  connectedAt: '2026-10-30T00:00:00Z',
  ...extra,
});

export const receiverCfg: ReceiverConfig = { host: 'ftp.picket.photos', user: 'camera', passiveMin: 30000, passiveMax: 30009, passwordSecretId: 'sec', instanceId: 'i-1' };

export function fakeCloud(initial = { password: 'OldPass123', state: 'running' }) {
  const s = { ...initial, reloads: 0 };
  const cloud: ReceiverCloud = {
    getPassword: vi.fn(async () => s.password),
    setPassword: vi.fn(async (v: string) => {
      s.password = v;
    }),
    runReloadCommand: vi.fn(async () => {
      s.reloads++;
      return 'Success' as const;
    }),
    instanceState: vi.fn(async () => s.state),
    start: vi.fn(async () => {
      s.state = 'pending';
    }),
    stop: vi.fn(async () => {
      s.state = 'stopping';
    }),
  };
  return { cloud, s };
}

export const deps = (over: Partial<AppDeps> = {}): AppDeps => ({
  store: fakeStore(),
  connections: createMemoryConnectionStore(null),
  lightroom: { clientId: 'cid', scopes: ['openid'], redirectUri: 'adobe+x://adobeid/cid', albumName: 'Picket' },
  receiver: createReceiverService(receiverCfg, fakeCloud().cloud),
  fetchFn: vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
  ...over,
});

export const ev = (routeKey: string, extra: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 =>
  ({ routeKey, rawPath: '/', headers: {}, requestContext: {} as never, isBase64Encoded: false, ...extra }) as APIGatewayProxyEventV2;

export const body = (r: { body?: string }) => JSON.parse(r.body ?? 'null');

/** Route-table fetch mock: matches "METHOD url-substring". */
export function fakeFetch(routes: Record<string, (init?: RequestInit, url?: string) => Response | Promise<Response>>) {
  const calls: { method: string; url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, init });
    const key = Object.keys(routes).find((k) => {
      const [m, frag] = k.split(' ', 2);
      return m === method && url.includes(frag!);
    });
    if (!key) return new Response(`no fake route for ${method} ${url}`, { status: 599 });
    return routes[key]!(init, url);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

export const lrJson = (obj: unknown, status = 200) => new Response(`while (1) {}\n${JSON.stringify(obj)}`, { status });
