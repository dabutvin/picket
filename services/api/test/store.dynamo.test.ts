import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createStore } from '../src/store.js';

/** Capture the UpdateCommand inputs the real store sends to DynamoDB. */
function fakeDdb(): { ddb: DynamoDBDocumentClient; inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  const ddb = {
    send: async (cmd: { input: Record<string, unknown> }) => {
      inputs.push(cmd.input);
      return { Attributes: { photoId: 'p1' } };
    },
  } as unknown as DynamoDBDocumentClient;
  return { ddb, inputs };
}

const cfg = { tableName: 't', statusIndex: 'byStatus', lightroomIndex: 'byLightroomStatus', bucket: 'b' };

describe('DynamoDB store update expressions', () => {
  it('omits ExpressionAttributeNames when no placeholders are used (DynamoDB rejects an empty map)', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.setLightroom('p1', { status: 'uploading', updatedAt: 'now', attempts: 1 });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!).not.toHaveProperty('ExpressionAttributeNames');
    expect(inputs[0]!.UpdateExpression).toBe('SET lightroomStatus = :st, lightroom = :lr');
  });

  it('keeps ExpressionAttributeNames when the expression needs them', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.queueLightroom('p1');
    expect(inputs[0]!.ExpressionAttributeNames).toEqual({ '#s': 'status' });
  });

  it('picking no longer queues for Lightroom', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.setStatus('p1', 'pick');
    expect(inputs[0]!.UpdateExpression).toBe('SET #s = :s, decidedAt = :t');
    expect(JSON.stringify(inputs[0])).not.toContain('queued');
  });

  it('queueLightroom only touches picks that are not already uploading or delivered', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.queueLightroom('p1');
    expect(inputs[0]!.ConditionExpression).toBe(
      'attribute_exists(photoId) AND #s = :pick AND (attribute_not_exists(lightroomStatus) OR lightroomStatus IN (:st, :failed))',
    );
    expect(inputs[0]!.ExpressionAttributeValues).toMatchObject({ ':st': 'queued', ':pick': 'pick', ':failed': 'failed' });
  });

  it('setLightroom can move the photo to sent in the same write', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.setLightroom('p1', { status: 'done', updatedAt: 'now' }, 'sent');
    expect(inputs[0]!.UpdateExpression).toBe('SET lightroomStatus = :st, lightroom = :lr, #s = :s');
    expect(inputs[0]!.ExpressionAttributeValues).toMatchObject({ ':st': 'done', ':s': 'sent' });
  });
});
