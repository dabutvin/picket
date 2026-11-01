/**
 * Scheduled every few minutes (EventBridge): announce newly synced photos once a burst from the
 * camera has gone quiet. The logic lives in notifications.ts; this file only wires AWS clients.
 */
import { env } from './config.js';
import { createStore } from './store.js';
import { createApnsPush, createDynamoDeviceStore, loadApnsKey, runNotifier, type PushFn } from './notifications.js';

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
  return async () => {
    const outcome = await runNotifier({ store, devices, push: await push() });
    if (outcome.action !== 'none') console.log('notifier', JSON.stringify(outcome));
    return outcome;
  };
})();
