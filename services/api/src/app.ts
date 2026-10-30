import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AdobeError, IMS_AUTHORIZE_URL, IMS_TOKEN_URL, LightroomClient, refreshTokens, type FetchFn } from './adobe.js';
import { ensureAccessToken, type ConnectionStore } from './connection.js';
import { BadCursor, type Store } from './store.js';
import {
  LIGHTROOM_STATUSES,
  PHOTO_STATUSES,
  type ConnectRequest,
  type LightroomConnection,
  type LightroomStatus,
  type LightroomStatusView,
  type Photo,
  type PhotoItem,
  type PhotoPage,
  type PhotoStatus,
  type RawUrl,
  type Stats,
} from './types.js';

export const PREVIEW_URL_TTL = 60 * 60; // 1 h: enough for a review session
export const RAW_URL_TTL = 15 * 60; // 15 min
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export interface LightroomConfig {
  clientId: string;
  scopes: string[];
  /** Fixed by Adobe for Native App credentials: adobe+<hash>://adobeid/<clientId>. The app must register that scheme. */
  redirectUri: string;
  albumName: string;
}

export interface AppDeps {
  store: Store;
  connections: ConnectionStore;
  lightroom: LightroomConfig;
  fetchFn?: FetchFn;
}

type Result = APIGatewayProxyStructuredResultV2;

const json = (statusCode: number, body: unknown): Result => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const error = (statusCode: number, message: string): Result => json(statusCode, { error: message });

const isStatus = (v: unknown): v is PhotoStatus => typeof v === 'string' && (PHOTO_STATUSES as readonly string[]).includes(v);

const parseBody = <T>(event: APIGatewayProxyEventV2): T | undefined => {
  try {
    return JSON.parse(event.body ?? '{}') as T;
  } catch {
    return undefined;
  }
};

export function createApp({ store, connections, lightroom, fetchFn = fetch }: AppDeps) {
  async function withUrls(item: PhotoItem): Promise<Photo> {
    const [previewUrl, thumbUrl] = await Promise.all([
      store.signGet(item.previewKey, PREVIEW_URL_TTL),
      store.signGet(item.thumbKey, PREVIEW_URL_TTL),
    ]);
    return { ...item, previewUrl, thumbUrl };
  }

  async function listPhotos(event: APIGatewayProxyEventV2): Promise<Result> {
    const q = event.queryStringParameters ?? {};
    const status = q.status ?? 'unreviewed';
    if (!isStatus(status)) return error(400, `status must be one of ${PHOTO_STATUSES.join(', ')}`);
    const limitRaw = q.limit === undefined ? DEFAULT_LIMIT : Number(q.limit);
    if (!Number.isInteger(limitRaw) || limitRaw < 1) return error(400, 'limit must be a positive integer');
    const limit = Math.min(limitRaw, MAX_LIMIT);

    let page;
    try {
      page = await store.listByStatus(status, limit, q.cursor);
    } catch (err) {
      if (err instanceof BadCursor) return error(400, 'invalid cursor');
      throw err;
    }
    const body: PhotoPage = { items: await Promise.all(page.items.map(withUrls)), cursor: page.cursor };
    return json(200, body);
  }

  async function decide(event: APIGatewayProxyEventV2): Promise<Result> {
    const id = event.pathParameters?.id;
    if (!id) return error(400, 'missing id');
    const body = parseBody<{ decision?: unknown }>(event);
    if (!body) return error(400, 'body must be JSON');
    if (!isStatus(body.decision)) return error(400, `decision must be one of ${PHOTO_STATUSES.join(', ')}`);
    const updated = await store.setStatus(id, body.decision);
    if (!updated) return error(404, 'photo not found');
    return json(200, await withUrls(updated));
  }

  async function rawUrl(event: APIGatewayProxyEventV2): Promise<Result> {
    const id = event.pathParameters?.id;
    if (!id) return error(400, 'missing id');
    const item = await store.get(id);
    if (!item) return error(404, 'photo not found');
    const body: RawUrl = {
      url: await store.signGet(item.rawKey, RAW_URL_TTL, item.fileName),
      fileName: item.fileName,
      bytes: item.bytes,
      expiresInSeconds: RAW_URL_TTL,
    };
    return json(200, body);
  }

  async function retryLightroom(event: APIGatewayProxyEventV2): Promise<Result> {
    const id = event.pathParameters?.id;
    if (!id) return error(400, 'missing id');
    const updated = await store.requeueLightroom(id);
    if (!updated) return error(409, 'photo not found or not a pick');
    return json(200, await withUrls(updated));
  }

  async function stats(): Promise<Result> {
    const [photoCounts, lrCounts] = await Promise.all([
      Promise.all(PHOTO_STATUSES.map(async (s) => [s, await store.countByStatus(s)] as const)),
      Promise.all(LIGHTROOM_STATUSES.map(async (s) => [s, await store.countByLightroomStatus(s)] as const)),
    ]);
    const body: Stats = {
      photos: Object.fromEntries(photoCounts) as Record<PhotoStatus, number>,
      lightroom: Object.fromEntries(lrCounts) as Record<LightroomStatus, number>,
    };
    return json(200, body);
  }

  const view = (conn: LightroomConnection | null): LightroomStatusView => ({
    connected: conn !== null,
    email: conn?.email,
    catalogId: conn?.catalogId,
    albumId: conn?.albumId,
    albumName: lightroom.albumName,
    storage: conn?.storage,
    connectedAt: conn?.connectedAt,
    oauth: {
      clientId: lightroom.clientId,
      scopes: lightroom.scopes,
      redirectUri: lightroom.redirectUri,
      authorizeUrl: IMS_AUTHORIZE_URL,
      tokenUrl: IMS_TOKEN_URL,
    },
  });

  async function lightroomStatus(): Promise<Result> {
    return json(200, view(await connections.load()));
  }

  /**
   * The app finished the PKCE flow and hands us the tokens. We verify them against
   * Lightroom (entitlement + catalog) before storing anything.
   */
  async function connect(event: APIGatewayProxyEventV2): Promise<Result> {
    if (!lightroom.clientId) return error(503, 'Lightroom client id is not configured on the server');
    const body = parseBody<Partial<ConnectRequest>>(event);
    if (!body?.refreshToken || typeof body.refreshToken !== 'string') return error(400, 'refreshToken is required');

    let conn: LightroomConnection = {
      refreshToken: body.refreshToken,
      accessToken: typeof body.accessToken === 'string' ? body.accessToken : undefined,
      expiresAt:
        typeof body.expiresIn === 'number' && body.accessToken
          ? new Date(Date.now() + body.expiresIn * 1000).toISOString()
          : undefined,
      connectedAt: new Date().toISOString(),
    };

    try {
      if (!conn.accessToken) {
        const t = await refreshTokens(fetchFn, lightroom.clientId, conn.refreshToken);
        conn = { ...conn, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt };
      }
      const client = new LightroomClient(fetchFn, lightroom.clientId, conn.accessToken!);
      const account = await client.account();
      if (!['subscriber', 'trial'].includes(account.entitlement?.status)) {
        return error(403, `Adobe account is not entitled to Lightroom (status: ${account.entitlement?.status ?? 'unknown'})`);
      }
      const catalog = await client.catalog();
      conn = {
        ...conn,
        email: account.email,
        accountId: account.id,
        catalogId: catalog.id,
        storage: account.entitlement.storage ? { used: account.entitlement.storage.used, limit: account.entitlement.storage.limit } : undefined,
      };
    } catch (err) {
      if (err instanceof AdobeError) return error(502, `Adobe rejected the connection: ${err.message}`);
      throw err;
    }

    // Keep the album from a previous connection to the same catalog.
    const previous = await connections.load();
    if (previous && previous.catalogId === conn.catalogId && previous.albumId) conn.albumId = previous.albumId;

    await connections.save(conn);
    return json(200, view(conn));
  }

  async function disconnect(): Promise<Result> {
    await connections.clear();
    return json(200, view(null));
  }

  /** Re-read account/storage from Adobe; cheap way for the app to show quota. */
  async function refreshConnection(): Promise<Result> {
    const conn = await connections.load();
    if (!conn) return error(404, 'Lightroom is not connected');
    try {
      const { accessToken, conn: fresh } = await ensureAccessToken(connections, conn, fetchFn, lightroom.clientId);
      const account = await new LightroomClient(fetchFn, lightroom.clientId, accessToken).account();
      const next: LightroomConnection = {
        ...fresh,
        email: account.email,
        storage: account.entitlement.storage ? { used: account.entitlement.storage.used, limit: account.entitlement.storage.limit } : fresh.storage,
      };
      await connections.save(next);
      return json(200, view(next));
    } catch (err) {
      if (err instanceof AdobeError) return error(502, `Adobe error: ${err.message}`);
      throw err;
    }
  }

  return async function handle(event: APIGatewayProxyEventV2): Promise<Result> {
    try {
      switch (event.routeKey) {
        case 'GET /photos':
          return await listPhotos(event);
        case 'POST /photos/{id}/decision':
          return await decide(event);
        case 'GET /photos/{id}/raw-url':
          return await rawUrl(event);
        case 'POST /photos/{id}/lightroom':
          return await retryLightroom(event);
        case 'GET /stats':
          return await stats();
        case 'GET /lightroom':
          return await lightroomStatus();
        case 'POST /lightroom':
          return await connect(event);
        case 'POST /lightroom/refresh':
          return await refreshConnection();
        case 'DELETE /lightroom':
          return await disconnect();
        default:
          return error(404, `no route ${event.routeKey}`);
      }
    } catch (err) {
      console.error('unhandled', err);
      return error(500, 'internal error');
    }
  };
}
