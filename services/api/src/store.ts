import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PhotoItem, PhotoStatus } from './types.js';

export interface Store {
  listByStatus(status: PhotoStatus, limit: number, cursor?: string): Promise<{ items: PhotoItem[]; cursor?: string }>;
  get(photoId: string): Promise<PhotoItem | undefined>;
  setStatus(photoId: string, status: PhotoStatus): Promise<PhotoItem | undefined>;
  signGet(key: string, expiresInSeconds: number, downloadAs?: string): Promise<string>;
}

export interface StoreConfig {
  tableName: string;
  statusIndex: string;
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

export function createStore(cfg: StoreConfig): Store {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client({});

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

    async setStatus(photoId, status) {
      try {
        const res = await ddb.send(
          new UpdateCommand({
            TableName: cfg.tableName,
            Key: { photoId },
            ConditionExpression: 'attribute_exists(photoId)',
            UpdateExpression: 'SET #s = :s, decidedAt = :t',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':s': status, ':t': new Date().toISOString() },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return res.Attributes as PhotoItem;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return undefined;
        throw err;
      }
    },

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
