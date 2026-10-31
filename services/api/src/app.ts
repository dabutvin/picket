import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AdobeError, IMS_AUTHORIZE_URL, IMS_TOKEN_URL, LightroomClient, refreshTokens, type FetchFn } from './adobe.js';
import { ensureAccessToken, type ConnectionStore } from './connection.js';
import { BadCursor, type Store } from './store.js';
import { BadPassword, type createReceiverService } from './receiver.js';
import { redeemPairingCode, type PairingStore } from './pairing.js';
import {
  DECISIONS,
  LIGHTROOM_STATUSES,
  PHOTO_STATUSES,
  type ConnectRequest,
  type Decision,
  type LightroomConnection,
  type LightroomStatus,
  type LightroomStatusView,
  type Photo,
  type PhotoItem,
  type PhotoPage,
  type PhotoStatus,
  type SendRequest,
  type SendResult,
  type Stats,
} from './types.js';

export const PREVIEW_URL_TTL = 60 * 60; // 1 h: enough for a review session
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
/** Picks queued in one POST /lightroom/send call; "send all" pages through the rest server-side. */
export const MAX_SEND = 100;

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
  /** Absent when the stack was deployed without the receiver. */
  receiver?: ReturnType<typeof createReceiverService>;
  pairing: PairingStore;
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
const isDecision = (v: unknown): v is Decision => typeof v === 'string' && (DECISIONS as readonly string[]).includes(v);

/** Lightroom already has it, whatever `status` says. */
const delivered = (p: PhotoItem) => p.lightroom?.status === 'done' || p.lightroom?.status === 'duplicate';

const parseBody = <T>(event: APIGatewayProxyEventV2): T | undefined => {
  try {
    return JSON.parse(event.body ?? '{}') as T;
  } catch {
    return undefined;
  }
};

export function createApp({ store, connections, lightroom, receiver, pairing, fetchFn = fetch }: AppDeps) {
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
    let items = page.items;
    if (status === 'pick') {
      // Picks from before the Sent stage existed (uploaded straight from the swipe) are moved
      // over the first time they are listed; no migration run needed.
      const legacy = items.filter(delivered);
      await Promise.all(legacy.map((p) => store.setStatus(p.photoId, 'sent')));
      items = items.filter((p) => !delivered(p));
    }
    const body: PhotoPage = { items: await Promise.all(items.map(withUrls)), cursor: page.cursor };
    return json(200, body);
  }

  async function decide(event: APIGatewayProxyEventV2): Promise<Result> {
    const id = event.pathParameters?.id;
    if (!id) return error(400, 'missing id');
    const body = parseBody<{ decision?: unknown }>(event);
    if (!body) return error(400, 'body must be JSON');
    if (!isDecision(body.decision)) return error(400, `decision must be one of ${DECISIONS.join(', ')}`);
    const updated = await store.setStatus(id, body.decision);
    if (!updated) return error(404, 'photo not found');
    return json(200, await withUrls(updated));
  }

  /** Send one pick to Lightroom, or retry / nudge one that failed or is stuck on queued. */
  async function sendOne(event: APIGatewayProxyEventV2): Promise<Result> {
    const id = event.pathParameters?.id;
    if (!id) return error(400, 'missing id');
    const updated = await store.queueLightroom(id);
    if (!updated) return error(409, 'photo not found, not a pick, or already on its way to Lightroom');
    return json(200, await withUrls(updated));
  }

  /** The Picks screen's "Send to Lightroom": a chosen batch, or every pick that is not already on its way. */
  async function sendMany(event: APIGatewayProxyEventV2): Promise<Result> {
    const body = parseBody<Partial<SendRequest>>(event);
    if (!body) return error(400, 'body must be JSON');
    let ids: string[];
    if (body.all === true) {
      ids = [];
      let cursor: string | undefined;
      do {
        const page = await store.listByStatus('pick', MAX_LIMIT, cursor);
        // Queued and uploading picks are already on their way; a stuck one is nudged from its detail view.
        ids.push(...page.items.filter((p) => !p.lightroomStatus || p.lightroomStatus === 'failed').map((p) => p.photoId));
        cursor = page.cursor;
      } while (cursor);
    } else {
      if (!Array.isArray(body.photoIds) || !body.photoIds.every((v) => typeof v === 'string' && v.length > 0)) {
        return error(400, 'photoIds must be an array of ids (or pass all: true)');
      }
      if (body.photoIds.length > MAX_SEND) return error(400, `at most ${MAX_SEND} photoIds per call`);
      ids = [...new Set(body.photoIds)];
    }
    const result: SendResult = { photos: [], skipped: [] };
    for (const id of ids) {
      const updated = await store.queueLightroom(id);
      if (updated) result.photos.push(await withUrls(updated));
      else result.skipped.push(id);
    }
    return json(200, result);
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
        return error(403, `Adobe account is not entitled to Lightroom (status: ${account.entitlement?.status ?? 'unknown'}). Sign in with the Adobe account that has the Lightroom plan and has been added as a beta user, and open Lightroom (web or mobile) with it once first.`);
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

  const noReceiver = () => error(503, 'The receiver is not deployed yet. Run deploy with the receiver enabled once EC2 is available in the AWS account.');

  async function receiverGet(): Promise<Result> {
    if (!receiver) return noReceiver();
    return json(200, await receiver.get());
  }

  async function receiverPassword(event: APIGatewayProxyEventV2): Promise<Result> {
    if (!receiver) return noReceiver();
    const body = parseBody<{ password?: unknown }>(event);
    if (!body) return error(400, 'body must be JSON');
    if (body.password !== undefined && typeof body.password !== 'string') return error(400, 'password must be a string');
    try {
      return json(200, await receiver.rotatePassword(body.password));
    } catch (err) {
      if (err instanceof BadPassword) return error(400, err.message);
      throw err;
    }
  }

  async function receiverPower(event: APIGatewayProxyEventV2): Promise<Result> {
    if (!receiver) return noReceiver();
    const body = parseBody<{ action?: unknown }>(event);
    if (body?.action !== 'start' && body?.action !== 'stop') return error(400, 'action must be start or stop');
    return json(200, await receiver.power(body.action));
  }

  /** The only unauthenticated route: swap a one-time pairing code for the bearer token. */
  async function pair(event: APIGatewayProxyEventV2): Promise<Result> {
    const body = parseBody<{ code?: unknown }>(event);
    if (!body || typeof body.code !== 'string' || !body.code.trim()) return error(400, 'code is required');
    const outcome = await redeemPairingCode(pairing, body.code);
    if (!outcome.ok) {
      const message = { invalid: 'That code is not valid', expired: 'That code has expired; run deploy or ops → pairing-code for a new one', used: 'That code was already used; run ops → pairing-code for a new one' }[outcome.reason];
      return error(outcome.reason === 'invalid' ? 401 : 410, message);
    }
    return json(200, { token: outcome.token });
  }

  return async function handle(event: APIGatewayProxyEventV2): Promise<Result> {
    try {
      switch (event.routeKey) {
        case 'POST /pair':
          return await pair(event);
        case 'GET /receiver':
          return await receiverGet();
        case 'POST /receiver/password':
          return await receiverPassword(event);
        case 'POST /receiver/power':
          return await receiverPower(event);
        case 'GET /photos':
          return await listPhotos(event);
        case 'POST /photos/{id}/decision':
          return await decide(event);
        case 'POST /photos/{id}/lightroom':
          return await sendOne(event);
        case 'POST /lightroom/send':
          return await sendMany(event);
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
