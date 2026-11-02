/**
 * New-photo notifications (ADR-010), event-driven. One function, two triggers:
 *
 * - the Photos table stream, filtered to INSERT: new photos. Starts or extends the burst (the
 *   first photo pushes "syncing") and queues a delayed "is it quiet yet?" message per batch;
 * - that delay queue: the message whose photo is still the newest closes the burst and pushes "done".
 *
 * The logic lives in notifications.ts; this file only wires AWS clients.
 */
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { env } from './config.js';
import { createStore } from './store.js';
import { QUIET_MS, createApnsPush, createDynamoDeviceStore, loadApnsKey, onQuiet, onUploads, type NotifierDeps, type PushFn } from './notifications.js';
import type { PhotoItem } from './types.js';

/** The APNs key, re-read now and then so a key added by a later deploy is picked up by a warm container. */
export function cachedPush(secretId: string | undefined, topic: string, ttlMs = 5 * 60_000): () => Promise<PushFn | null> {
  let cached: { at: number; push: PushFn | null } | undefined;
  return async () => {
    if (!secretId) return null;
    if (cached && Date.now() - cached.at < ttlMs) return cached.push;
    const key = await loadApnsKey(secretId);
    cached = { at: Date.now(), push: key ? createApnsPush(key, topic, process.env.APNS_HOST || undefined) : null };
    return cached.push;
  };
}

/** uploadedAt of each newly inserted photo in a stream batch (re-sent frames are MODIFY and never count). */
export function insertedUploads(event: DynamoDBStreamEvent): string[] {
  const out: string[] = [];
  for (const r of event.Records) {
    if (r.eventName !== 'INSERT' || !r.dynamodb?.NewImage) continue;
    const row = unmarshall(r.dynamodb.NewImage as Record<string, AttributeValue>) as PhotoItem;
    out.push(row.uploadedAt || new Date().toISOString());
  }
  return out;
}

export function createNotifierHandler(deps: () => Promise<NotifierDeps>) {
  return async (event: DynamoDBStreamEvent | SQSEvent) => {
    const d = await deps();
    const first = event.Records[0] as { eventSource?: string } | undefined;
    if (first?.eventSource === 'aws:sqs') {
      for (const r of (event as SQSEvent).Records) {
        const { lastUploadAt } = JSON.parse(r.body) as { lastUploadAt: string };
        const out = await onQuiet(lastUploadAt, d);
        if (out.done) console.log('burst done', JSON.stringify(out));
      }
      return;
    }
    const out = await onUploads(insertedUploads(event as DynamoDBStreamEvent), d);
    if (out.started) console.log('burst started');
  };
}

export const handler = (() => {
  if (process.env.NODE_ENV === 'test') return undefined;
  const store = createStore({
    tableName: env('PHOTOS_TABLE'),
    statusIndex: process.env.STATUS_INDEX ?? 'byStatus',
    lightroomIndex: process.env.LIGHTROOM_INDEX ?? 'byLightroomStatus',
    bucket: env('PHOTOS_BUCKET'),
  });
  const devices = createDynamoDeviceStore(env('NOTIFY_TABLE'));
  const push = cachedPush(process.env.APNS_SECRET_ARN, env('APNS_TOPIC'));
  const sqs = new SQSClient({});
  const queueUrl = env('QUIET_QUEUE_URL');
  const later = async (lastUploadAt: string) => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ lastUploadAt }), DelaySeconds: QUIET_MS / 1000 }));
  };
  return createNotifierHandler(async () => ({ store, devices, push: await push(), later }));
})();
