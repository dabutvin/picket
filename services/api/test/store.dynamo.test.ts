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
  it('setLightroom without a status change still stamps the change feed', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.setLightroom('p1', { status: 'uploading', updatedAt: 'now', attempts: 1 });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.UpdateExpression).toBe('SET lightroomStatus = :st, lightroom = :lr, #ch = :ch, #fd = :fd');
    expect(inputs[0]!.ExpressionAttributeNames).toEqual({ '#ch': 'changedAt', '#fd': 'feed' });
  });

  it('keeps ExpressionAttributeNames when the expression needs them', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.queueLightroom('p1');
    expect(inputs[0]!.ExpressionAttributeNames).toEqual({ '#s': 'status', '#ch': 'changedAt', '#fd': 'feed' });
  });

  it('picking no longer queues for Lightroom', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.setStatus('p1', 'pick');
    expect(inputs[0]!.UpdateExpression).toBe('SET #s = :s, decidedAt = :t, #ch = :ch, #fd = :fd');
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
    expect(inputs[0]!.UpdateExpression).toBe('SET lightroomStatus = :st, lightroom = :lr, #s = :s, #ch = :ch, #fd = :fd');
    expect(inputs[0]!.ExpressionAttributeValues).toMatchObject({ ':st': 'done', ':s': 'sent' });
  });
});

describe('change feed', () => {
  it('every row write stamps changedAt (toISOString format) and feed', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.setStatus('p1', 'reject');
    await store.setLightroom('p1', { status: 'done', updatedAt: 'now' }, 'sent');
    await store.queueLightroom('p1');
    for (const input of inputs) {
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':fd']).toBe('photos');
      expect(values[':ch']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(String(input.UpdateExpression)).toContain('#ch = :ch, #fd = :fd');
    }
  });

  it('listChanges queries byChange after since, oldest first', async () => {
    const { ddb, inputs } = fakeDdb();
    const store = createStore(cfg as never, { ddb });
    await store.listChanges('2026-11-01T09:00:00.000Z', 50);
    expect(inputs[0]).toMatchObject({
      IndexName: 'byChange',
      KeyConditionExpression: '#fd = :fd AND #ch > :since',
      ExpressionAttributeValues: { ':fd': 'photos', ':since': '2026-11-01T09:00:00.000Z' },
      ScanIndexForward: true,
      Limit: 50,
    });
  });

  it('getMany retries unprocessed keys', async () => {
    const inputs: Record<string, unknown>[] = [];
    let call = 0;
    const ddb = {
      send: async (cmd: { input: Record<string, unknown> }) => {
        inputs.push(cmd.input);
        call++;
        return call === 1
          ? { Responses: { t: [{ photoId: 'a' }] }, UnprocessedKeys: { t: { Keys: [{ photoId: 'b' }] } } }
          : { Responses: { t: [{ photoId: 'b' }] } };
      },
    } as unknown as DynamoDBDocumentClient;
    const store = createStore(cfg as never, { ddb });
    const rows = await store.getMany(['a', 'b', 'a']);
    expect(rows.map((r) => r.photoId)).toEqual(['a', 'b']);
    expect((inputs[0]!.RequestItems as Record<string, { Keys: unknown[] }>).t!.Keys).toEqual([{ photoId: 'a' }, { photoId: 'b' }]);
    expect((inputs[1]!.RequestItems as Record<string, { Keys: unknown[] }>).t!.Keys).toEqual([{ photoId: 'b' }]);
  });
});
