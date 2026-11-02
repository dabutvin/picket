/**
 * New-photo notifications (ADR-010). Runs on the Photos table stream, filtered to INSERT: every
 * batch of new photos pushes "syncing" to each phone that doesn't already hold an unread one.
 * The logic lives in notifications.ts; this file only wires AWS clients.
 */
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { env } from './config.js';
import { createStore } from './store.js';
import { createApnsPush, createDynamoDeviceStore, loadApnsKey, onUploads, type NotifierDeps, type PushFn } from './notifications.js';

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

/** New photos in a stream batch (a re-sent frame is a MODIFY and never counts; the event filter drops those too). */
export const insertedCount = (event: DynamoDBStreamEvent) => event.Records.filter((r) => r.eventName === 'INSERT').length;

export function createNotifierHandler(deps: () => Promise<NotifierDeps>) {
  return async (event: DynamoDBStreamEvent) => {
    const out = await onUploads(insertedCount(event), await deps());
    if (out.notified) console.log('notified', JSON.stringify(out));
    return out;
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
  return createNotifierHandler(async () => ({ store, devices, push: await push() }));
})();
