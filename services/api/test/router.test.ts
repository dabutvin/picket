import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import { createRouter, shouldEnqueue } from '../src/router.js';

const rec = (eventName: 'INSERT' | 'MODIFY' | 'REMOVE', oldImage?: object, newImage?: object) => ({
  eventName,
  dynamodb: {
    OldImage: oldImage ? marshall(oldImage) : undefined,
    NewImage: newImage ? marshall(newImage) : undefined,
  },
});

describe('shouldEnqueue', () => {
  it('fires on transitions into queued and on bumped retries only', () => {
    expect(shouldEnqueue(undefined, { lightroomStatus: 'queued' })).toBe(true);
    expect(shouldEnqueue({ lightroomStatus: 'failed' }, { lightroomStatus: 'queued' })).toBe(true);
    expect(shouldEnqueue({ lightroomStatus: 'queued', lightroom: { status: 'queued', updatedAt: '1' } }, { lightroomStatus: 'queued', lightroom: { status: 'queued', updatedAt: '2' } })).toBe(true);
    expect(shouldEnqueue({ lightroomStatus: 'queued', lightroom: { status: 'queued', updatedAt: '1' } }, { lightroomStatus: 'queued', lightroom: { status: 'queued', updatedAt: '1' } })).toBe(false);
    expect(shouldEnqueue({ lightroomStatus: 'queued' }, { lightroomStatus: 'uploading' })).toBe(false);
    expect(shouldEnqueue(undefined, { status: 'pick' })).toBe(false);
  });
});

describe('router', () => {
  it('sends one message per newly queued row and ignores REMOVE', async () => {
    const send = vi.fn(async () => {});
    const handle = createRouter(send);
    const event = {
      Records: [
        rec('INSERT', undefined, { photoId: 'a', lightroomStatus: 'queued' }),
        rec('MODIFY', { photoId: 'b', lightroomStatus: 'queued' }, { photoId: 'b', lightroomStatus: 'done' }),
        rec('MODIFY', { photoId: 'c', status: 'unreviewed' }, { photoId: 'c', status: 'pick', lightroomStatus: 'queued' }),
        rec('REMOVE', { photoId: 'd', lightroomStatus: 'queued' }, undefined),
      ],
    } as unknown as DynamoDBStreamEvent;
    const r = await handle(event);
    expect(r.enqueued).toEqual(['a', 'c']);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
