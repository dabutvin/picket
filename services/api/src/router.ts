/**
 * DynamoDB Streams consumer: whenever a row's lightroomStatus becomes "queued",
 * put its photoId on the upload queue. Keeps the API and the uploader decoupled.
 */
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { PhotoItem } from './types.js';

export function shouldEnqueue(oldImage: Partial<PhotoItem> | undefined, newImage: Partial<PhotoItem> | undefined): boolean {
  if (newImage?.lightroomStatus !== 'queued') return false;
  if (oldImage?.lightroomStatus !== 'queued') return true;
  // Re-queued while already queued: the API bumps updatedAt to signal a retry.
  return oldImage.lightroom?.updatedAt !== newImage.lightroom?.updatedAt;
}

export function createRouter(send: (photoId: string) => Promise<void>) {
  return async function handle(event: DynamoDBStreamEvent): Promise<{ enqueued: string[] }> {
    const enqueued: string[] = [];
    for (const record of event.Records) {
      if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue;
      const newImage = record.dynamodb?.NewImage ? (unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>) as PhotoItem) : undefined;
      const oldImage = record.dynamodb?.OldImage ? (unmarshall(record.dynamodb.OldImage as Record<string, AttributeValue>) as PhotoItem) : undefined;
      if (newImage && shouldEnqueue(oldImage, newImage)) {
        await send(newImage.photoId);
        enqueued.push(newImage.photoId);
      }
    }
    return { enqueued };
  };
}

export const handler = (() => {
  if (process.env.NODE_ENV === 'test') return undefined;
  const sqs = new SQSClient({});
  const queueUrl = process.env.UPLOAD_QUEUE_URL;
  if (!queueUrl) throw new Error('missing env UPLOAD_QUEUE_URL');
  return createRouter(async (photoId) => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ photoId }) }));
  });
})();
