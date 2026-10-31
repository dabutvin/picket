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
    await store.requeueLightroom('p1');
    expect(inputs[0]!.ExpressionAttributeNames).toEqual({ '#s': 'status' });
  });
});
