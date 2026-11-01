import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { LightroomInfo, LightroomStatus, PhotoItem, PhotoStatus } from './types.js';

export interface Store {
  listByStatus(status: PhotoStatus, limit: number, cursor?: string): Promise<{ items: PhotoItem[]; cursor?: string }>;
  get(photoId: string): Promise<PhotoItem | undefined>;
  /** Up to 100 rows by id; missing ids are left out. */
  getMany(photoIds: string[]): Promise<PhotoItem[]>;
  /** Rows whose changedAt is after `since`, oldest change first (the byChange index). */
  listChanges(since: string, limit: number, cursor?: string): Promise<{ items: PhotoItem[]; cursor?: string }>;
  /** Flip the review decision (or, from the uploader, mark a pick as sent). Never queues anything. */
  setStatus(photoId: string, status: PhotoStatus): Promise<PhotoItem | undefined>;
  /** Record progress of the Lightroom upload; `status` moves the photo along with it (pick → sent). */
  setLightroom(photoId: string, info: LightroomInfo, status?: PhotoStatus): Promise<PhotoItem | undefined>;
  /**
   * Put a pick on the Lightroom queue: a first send, a retry after a failure, or a nudge for one
   * stuck on queued. Undefined when it is not a pick or is already uploading / in Lightroom.
   */
  queueLightroom(photoId: string): Promise<PhotoItem | undefined>;
  countByStatus(status: PhotoStatus): Promise<number>;
  countByLightroomStatus(status: LightroomStatus): Promise<number>;
  /** Presigned GET for a preview or thumb. */
  signGet(key: string, expiresInSeconds: number): Promise<string>;
}

export interface StoreConfig {
  tableName: string;
  statusIndex: string;
  lightroomIndex: string;
  /** Defaults to byChange. */
  changeIndex?: string;
  bucket: string;
}

/** Partition key of the byChange index: every row shares it (one user, a few writes a minute). */
export const FEED = 'photos';

/** Appended to every row write so the row shows up in the change feed. */
const stamp = (now = new Date()) => ({
  expr: ', #ch = :ch, #fd = :fd',
  names: { '#ch': 'changedAt', '#fd': 'feed' },
  values: { ':ch': now.toISOString(), ':fd': FEED },
});

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

export function createStore(cfg: StoreConfig, clients: { ddb?: DynamoDBDocumentClient; s3?: S3Client } = {}): Store {
  const ddb =
    clients.ddb ??
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const s3 = clients.s3 ?? new S3Client({});

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
          // DynamoDB rejects an empty map ("ExpressionAttributeNames must not be empty"); omit it when unused.
          ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
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

    async getMany(photoIds) {
      let keys: Record<string, unknown>[] = [...new Set(photoIds)].map((photoId) => ({ photoId }));
      const out: PhotoItem[] = [];
      // BatchGet may hand some keys back unprocessed under load; a few retries is plenty for 100.
      for (let attempt = 0; keys.length > 0 && attempt < 4; attempt++) {
        const res = await ddb.send(new BatchGetCommand({ RequestItems: { [cfg.tableName]: { Keys: keys } } }));
        out.push(...((res.Responses?.[cfg.tableName] ?? []) as PhotoItem[]));
        keys = (res.UnprocessedKeys?.[cfg.tableName]?.Keys ?? []) as Record<string, unknown>[];
      }
      return out;
    },

    async listChanges(since, limit, cursor) {
      const res = await ddb.send(
        new QueryCommand({
          TableName: cfg.tableName,
          IndexName: cfg.changeIndex ?? 'byChange',
          KeyConditionExpression: '#fd = :fd AND #ch > :since',
          ExpressionAttributeNames: { '#fd': 'feed', '#ch': 'changedAt' },
          ExpressionAttributeValues: { ':fd': FEED, ':since': since },
          ScanIndexForward: true,
          Limit: limit,
          ExclusiveStartKey: decodeCursor(cursor),
        }),
      );
      return { items: (res.Items ?? []) as PhotoItem[], cursor: encodeCursor(res.LastEvaluatedKey) };
    },

    setStatus(photoId, status) {
      // Picking no longer queues anything: the Picks screen sends to Lightroom explicitly.
      // A photo that already went to Lightroom keeps its lightroom record whatever happens here.
      const now = new Date();
      const c = stamp(now);
      return update(photoId, 'SET #s = :s, decidedAt = :t' + c.expr, { '#s': 'status', ...c.names }, { ':s': status, ':t': now.toISOString(), ...c.values });
    },

    setLightroom(photoId, info, status) {
      const c = stamp();
      if (status) {
        return update(
          photoId,
          'SET lightroomStatus = :st, lightroom = :lr, #s = :s' + c.expr,
          { '#s': 'status', ...c.names },
          { ':st': info.status, ':lr': info, ':s': status, ...c.values },
        );
      }
      return update(photoId, 'SET lightroomStatus = :st, lightroom = :lr' + c.expr, c.names, { ':st': info.status, ':lr': info, ...c.values });
    },

    queueLightroom(photoId) {
      const info = queuedInfo();
      const c = stamp();
      // Already queued is allowed: the bumped updatedAt makes the router re-send the message
      // (recovery for a pick stuck on Queued). Uploading / done / duplicate are left alone.
      return update(
        photoId,
        'SET lightroomStatus = :st, lightroom = :lr' + c.expr,
        { '#s': 'status', ...c.names },
        { ':st': info.status, ':lr': info, ':pick': 'pick', ':failed': 'failed', ...c.values },
        'attribute_exists(photoId) AND #s = :pick AND (attribute_not_exists(lightroomStatus) OR lightroomStatus IN (:st, :failed))',
      );
    },

    countByStatus: (status) => count(cfg.statusIndex, 'status', status),
    countByLightroomStatus: (status) => count(cfg.lightroomIndex, 'lightroomStatus', status),

    signGet(key, expiresInSeconds) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: expiresInSeconds });
    },
  };
}
