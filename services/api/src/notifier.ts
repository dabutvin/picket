/**
 * New-photo notifications (ADR-010), event-driven. One function, two triggers:
 *
 * - the Photos table stream, filtered to INSERT: new photos. Live transfer (synced within LIVE_MS
 *   of being taken) is dropped; the rest start or extend the burst (the first photo pushes
 *   "syncing") and queue a delayed "is it quiet yet?" message per batch;
 * - that delay queue: the message whose photo is still the newest closes the burst and pushes "done";
 * - an EventBridge Scheduler tick every 15 minutes ({kind: "reminder"}): about once a week, at a
 *   random day and time, "N photos waiting to review" if any are (phones can turn it off).
 *
 * The logic lives in notifications.ts; this file only wires AWS clients.
 */
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { env } from './config.js';
import { createStore } from './store.js';
// Never import this module from the API: its handler below reads the notifier's own environment
// (QUIET_QUEUE_URL, ...) at load time. Shared code lives in notifications.ts.
import { QUIET_MS, backlogUploads, cachedPush, createDynamoDeviceStore, onQuiet, onReminderTick, onUploads, type NotifierDeps } from './notifications.js';
import type { PhotoItem } from './types.js';

/**
 * uploadedAt of each newly inserted photo in a stream batch that counts: re-sent frames are MODIFY
 * and never count, and neither does live transfer (synced within LIVE_MS of being taken).
 */
export function insertedUploads(event: DynamoDBStreamEvent): string[] {
  const rows: PhotoItem[] = [];
  for (const r of event.Records) {
    if (r.eventName !== 'INSERT' || !r.dynamodb?.NewImage) continue;
    const row = unmarshall(r.dynamodb.NewImage as Record<string, AttributeValue>) as PhotoItem;
    rows.push({ ...row, uploadedAt: row.uploadedAt || new Date().toISOString() });
  }
  return backlogUploads(rows);
}

/** The reminder tick's payload (EventBridge Scheduler passes it as the event). */
export interface ReminderEvent {
  kind: 'reminder';
}

const reminderTimeZone = () => process.env.REMINDER_TIME_ZONE || 'America/New_York';

export function createNotifierHandler(deps: () => Promise<NotifierDeps>) {
  return async (event: DynamoDBStreamEvent | SQSEvent | ReminderEvent) => {
    const d = await deps();
    if ((event as ReminderEvent).kind === 'reminder') {
      const out = await onReminderTick({ ...d, timeZone: reminderTimeZone() });
      if (out.action !== 'wait') console.log('reminder', JSON.stringify(out));
      return;
    }
    event = event as DynamoDBStreamEvent | SQSEvent;
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
