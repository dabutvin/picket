/**
 * SQS consumer: one message per pick. Streams the RAW from S3 into the user's
 * Lightroom catalog and records progress on the Photos row.
 */
import { createHash } from 'node:crypto';
import type { SQSEvent } from 'aws-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AdobeError, LightroomClient, contentTypeFor, newLightroomId, type FetchFn } from './adobe.js';
import { createSecretsConnectionStore, ensureAccessToken, type ConnectionStore } from './connection.js';
import { env, lightroomConfigFromEnv } from './config.js';
import { createStore, type Store } from './store.js';
import type { LightroomConnection, LightroomInfo, PhotoItem } from './types.js';

export interface UploaderDeps {
  store: Pick<Store, 'get' | 'setLightroom'>;
  connections: ConnectionStore;
  getRaw: (key: string) => Promise<Uint8Array>;
  clientId: string;
  albumName: string;
  rawContentType?: string;
  fetchFn?: FetchFn;
  now?: () => Date;
}

export interface QueueMessage {
  photoId: string;
}

export type UploadOutcome = 'done' | 'duplicate' | 'skipped' | 'failed-permanent';

/** Thrown to make SQS retry the message. */
export class RetryableError extends Error {}

export function createUploader(deps: UploaderDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? (() => new Date());

  /**
   * Persist progress and keep a current view of the row so attempts/assetId accumulate across marks.
   * Once Lightroom has the photo (done or duplicate) the pick becomes `sent`, which moves it from the
   * app's Picks tab to its Sent tab.
   */
  async function mark(current: PhotoItem, patch: Partial<LightroomInfo> & { status: LightroomInfo['status'] }): Promise<PhotoItem> {
    const info: LightroomInfo = {
      ...current.lightroom,
      ...patch,
      updatedAt: now().toISOString(),
      attempts: (current.lightroom?.attempts ?? 0) + (patch.status === 'uploading' ? 1 : 0),
    };
    const delivered = info.status === 'done' || info.status === 'duplicate';
    const saved = await deps.store.setLightroom(current.photoId, info, delivered ? 'sent' : undefined);
    return saved ?? { ...current, status: delivered ? 'sent' : current.status, lightroomStatus: info.status, lightroom: info };
  }

  async function ensureAlbum(client: LightroomClient, conn: LightroomConnection): Promise<LightroomConnection> {
    if (conn.albumId) return conn;
    const existing = (await client.listProjectAlbums(conn.catalogId!)).find((a) => a.payload?.name === deps.albumName);
    const albumId = existing?.id ?? newLightroomId();
    if (!existing) await client.createProjectAlbum(conn.catalogId!, albumId, deps.albumName);
    const next = { ...conn, albumId };
    await deps.connections.save(next);
    return next;
  }

  async function uploadOne(photoId: string): Promise<UploadOutcome> {
    let photo = await deps.store.get(photoId);
    if (!photo) return 'skipped';
    if (photo.status !== 'pick') return 'skipped'; // un-picked while queued
    if (photo.lightroom?.status === 'done' || photo.lightroom?.status === 'duplicate') return 'skipped';

    let conn = await deps.connections.load();
    if (!conn?.catalogId) {
      await mark(photo, { status: 'failed', error: 'Lightroom is not connected' });
      return 'failed-permanent';
    }

    // Fix the asset id up front so a retry after a half-finished upload reuses it.
    const assetId = photo.lightroom?.assetId ?? newLightroomId();
    photo = await mark(photo, { status: 'uploading', assetId, error: undefined });
    try {
      const { accessToken, conn: fresh } = await ensureAccessToken(deps.connections, conn, fetchFn, deps.clientId);
      conn = fresh;
      const client = new LightroomClient(fetchFn, deps.clientId, accessToken);
      conn = await ensureAlbum(client, conn);

      const bytes = await deps.getRaw(photo.rawKey);
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      const created = await client.createAsset(conn.catalogId!, assetId, {
        fileName: photo.fileName,
        captureDate: toAdobeDate(photo.capturedAt),
        importedBy: conn.accountId ?? 'picket',
        importTimestamp: now().toISOString(),
        sha256,
        fileSize: bytes.byteLength,
      });
      if (created === 'duplicate') {
        await mark(photo, { status: 'duplicate', albumId: conn.albumId });
        return 'duplicate';
      }

      await client.uploadMaster(conn.catalogId!, assetId, bytes, contentTypeFor(photo.fileName, deps.rawContentType));
      try {
        await client.addToAlbum(conn.catalogId!, conn.albumId!, [{ assetId, remoteId: photo.photoId }]);
      } catch (err) {
        // The photo is in the catalog; a missing album entry isn't worth a re-upload.
        console.warn('addToAlbum failed', photoId, err);
      }
      await mark(photo, { status: 'done', albumId: conn.albumId });
      return 'done';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof AdobeError && err.permanent;
      await mark(photo, { status: 'failed', error: message });
      if (permanent) return 'failed-permanent';
      throw new RetryableError(message);
    }
  }

  return async function handle(event: SQSEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      let msg: QueueMessage;
      try {
        msg = JSON.parse(record.body) as QueueMessage;
      } catch {
        console.error('bad message', record.body);
        continue;
      }
      try {
        const outcome = await uploadOne(msg.photoId);
        console.log(JSON.stringify({ photoId: msg.photoId, outcome }));
      } catch (err) {
        console.error('upload failed, will retry', msg.photoId, err);
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

/** Lightroom wants ISO-8601; capturedAt has no zone (camera local time), which Lightroom accepts as-is. */
export function toAdobeDate(iso: string): string {
  return iso.length === 19 ? iso : new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const handler = (() => {
  if (process.env.NODE_ENV === 'test') return undefined;
  const s3 = new S3Client({});
  const bucket = env('PHOTOS_BUCKET');
  const cfg = lightroomConfigFromEnv();
  return createUploader({
    store: createStore({
      tableName: env('PHOTOS_TABLE'),
      statusIndex: process.env.STATUS_INDEX ?? 'byStatus',
      lightroomIndex: process.env.LIGHTROOM_INDEX ?? 'byLightroomStatus',
      bucket,
    }),
    connections: createSecretsConnectionStore(env('LIGHTROOM_SECRET_ARN')),
    getRaw: async (key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) throw new Error(`empty body for ${key}`);
      return res.Body.transformToByteArray();
    },
    clientId: cfg.clientId,
    albumName: cfg.albumName,
    rawContentType: process.env.LIGHTROOM_RAW_CONTENT_TYPE,
  });
})();
