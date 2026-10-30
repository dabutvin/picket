import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { LightroomInfo, LightroomStatus, PhotoItem, PhotoStatus } from './types.js';

export interface Store {
  listByStatus(status: PhotoStatus, limit: number, cursor?: string): Promise<{ items: PhotoItem[]; cursor?: string }>;
  get(photoId: string): Promise<PhotoItem | undefined>;
  /** Flip the review decision. A first-time pick is also queued for Lightroom. */
  setStatus(photoId: string, status: PhotoStatus): Promise<PhotoItem | undefined>;
  /** Record progress of the Lightroom upload. */
  setLightroom(photoId: string, info: LightroomInfo): Promise<PhotoItem | undefined>;
  /** Put a pick back on the Lightroom queue (retry after a failure). */
  requeueLightroom(photoId: string): Promise<PhotoItem | undefined>;
  countByStatus(status: PhotoStatus): Promise<number>;
  countByLightroomStatus(status: LightroomStatus): Promise<number>;
  signGet(key: string, expiresInSeconds: number, downloadAs?: string): Promise<string>;
}

export interface StoreConfig {
  tableName: string;
  statusIndex: string;
  lightroomIndex: string;
  bucket: string;
}

export const encodeCursor = (key: Record<string, unknown> | undefined): string | undefined =>
  key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : undefined;

export const decodeCursor = (cursor: string | undefined): Record<string, unknown> | undefined => {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new BadCursor();
};

export class BadCursor extends Error {
  constructor() {
    super('invalid cursor');
  }
}

export const queuedInfo = (now = new Date()): LightroomInfo => ({ status: 'queued', updatedAt: now.toISOString() });

const isConditionFailure = (err: unknown) => (err as { name?: string }).name === 'ConditionalCheckFailedException';

export function createStore(cfg: StoreConfig): Store {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client({});

  async function update(
    photoId: string,
    expr: string,
    names: Record<string, string>,
    values: Record<string, unknown>,
    condition = 'attribute_exists(photoId)',
  ): Promise<PhotoItem | undefined> {
    try {
      const res = await ddb.send(
        new UpdateCommand({
          TableName: cfg.tableName,
          Key: { photoId },
          ConditionExpression: condition,
          UpdateExpression: expr,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return res.Attributes as PhotoItem;
    } catch (err) {
      if (isConditionFailure(err)) return undefined;
      throw err;
    }
  }

  async function count(index: string, attr: string, value: string): Promise<number> {
    let total = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: cfg.tableName,
          IndexName: index,
          KeyConditionExpression: '#k = :v',
          ExpressionAttributeNames: { '#k': attr },
          ExpressionAttributeValues: { ':v': value },
          Select: 'COUNT',
          ExclusiveStartKey: startKey,
        }),
      );
      total += res.Count ?? 0;
      startKey = res.LastEvaluatedKey;
    } while (startKey);
    return total;
  }

  return {
    async listByStatus(status, limit, cursor) {
      const res = await ddb.send(
        new QueryCommand({
          TableName: cfg.tableName,
          IndexName: cfg.statusIndex,
          KeyConditionExpression: '#s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status },
          ScanIndexForward: true, // oldest first: review in the order you shot
          Limit: limit,
          ExclusiveStartKey: decodeCursor(cursor),
        }),
      );
      return { items: (res.Items ?? []) as PhotoItem[], cursor: encodeCursor(res.LastEvaluatedKey) };
    },

    async get(photoId) {
      const res = await ddb.send(new GetCommand({ TableName: cfg.tableName, Key: { photoId } }));
      return res.Item as PhotoItem | undefined;
    },

    setStatus(photoId, status) {
      const now = new Date();
      if (status === 'pick') {
        // if_not_exists: a photo that already went to Lightroom (or failed) keeps its record;
        // failures are retried explicitly through requeueLightroom.
        return update(
          photoId,
          'SET #s = :s, decidedAt = :t, lightroomStatus = if_not_exists(lightroomStatus, :q), lightroom = if_not_exists(lightroom, :lr)',
          { '#s': 'status' },
          { ':s': status, ':t': now.toISOString(), ':q': 'queued', ':lr': queuedInfo(now) },
        );
      }
      return update(photoId, 'SET #s = :s, decidedAt = :t', { '#s': 'status' }, { ':s': status, ':t': now.toISOString() });
    },

    setLightroom(photoId, info) {
      return update(photoId, 'SET lightroomStatus = :st, lightroom = :lr', {}, { ':st': info.status, ':lr': info });
    },

    requeueLightroom(photoId) {
      const info = queuedInfo();
      return update(
        photoId,
        'SET lightroomStatus = :st, lightroom = :lr',
        { '#s': 'status' },
        { ':st': info.status, ':lr': info, ':pick': 'pick' },
        'attribute_exists(photoId) AND #s = :pick',
      );
    },

    countByStatus: (status) => count(cfg.statusIndex, 'status', status),
    countByLightroomStatus: (status) => count(cfg.lightroomIndex, 'lightroomStatus', status),

    signGet(key, expiresInSeconds, downloadAs) {
      return getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          ...(downloadAs ? { ResponseContentDisposition: `attachment; filename="${downloadAs}"` } : {}),
        }),
        { expiresIn: expiresInSeconds },
      );
    },
  };
}
