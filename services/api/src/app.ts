import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BadCursor, type Store } from './store.js';
import { PHOTO_STATUSES, type Photo, type PhotoItem, type PhotoPage, type PhotoStatus, type RawUrl } from './types.js';

export const PREVIEW_URL_TTL = 60 * 60; // 1 h: enough for a review session
export const RAW_URL_TTL = 15 * 60; // 15 min: just long enough to download + share
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

type Result = APIGatewayProxyStructuredResultV2;

const json = (statusCode: number, body: unknown): Result => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const error = (statusCode: number, message: string): Result => json(statusCode, { error: message });

const isStatus = (v: unknown): v is PhotoStatus => typeof v === 'string' && (PHOTO_STATUSES as readonly string[]).includes(v);

export function createApp(store: Store) {
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
    let decision: unknown;
    try {
      decision = (JSON.parse(event.body ?? '{}') as { decision?: unknown }).decision;
    } catch {
      return error(400, 'body must be JSON');
    }
    if (!isStatus(decision)) return error(400, `decision must be one of ${PHOTO_STATUSES.join(', ')}`);
    const updated = await store.setStatus(id, decision);
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

  return async function handle(event: APIGatewayProxyEventV2): Promise<Result> {
    try {
      switch (event.routeKey) {
        case 'GET /photos':
          return await listPhotos(event);
        case 'POST /photos/{id}/decision':
          return await decide(event);
        case 'GET /photos/{id}/raw-url':
          return await rawUrl(event);
        default:
          return error(404, `no route ${event.routeKey}`);
      }
    } catch (err) {
      console.error('unhandled', err);
      return error(500, 'internal error');
    }
  };
}
