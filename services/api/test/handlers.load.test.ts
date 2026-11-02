import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Each Lambda entry point builds its handler when the module loads, from that Lambda's own
 * environment. Load them for real (NODE_ENV not "test") with exactly the variables infra gives
 * each function, so a module that reads another function's variables fails here, not in AWS.
 * (The API once imported notifier.ts, whose load needs QUIET_QUEUE_URL: every request 500ed.)
 */
const API_ENV = {
  PHOTOS_TABLE: 't',
  PHOTOS_BUCKET: 'b',
  STATUS_INDEX: 'byStatus',
  LIGHTROOM_INDEX: 'byLightroomStatus',
  CHANGE_INDEX: 'byChange',
  LIGHTROOM_SECRET_ARN: 'arn:lr',
  LIGHTROOM_CLIENT_ID: 'c',
  LIGHTROOM_SCOPES: 'openid',
  LIGHTROOM_REDIRECT_URI: 'adobe+x://adobeid/c',
  LIGHTROOM_ALBUM_NAME: 'Picket',
  PAIRING_SECRET_ARN: 'arn:pair',
  TOKEN_SECRET_ARN: 'arn:tok',
  NOTIFY_TABLE: 'n',
  APNS_SECRET_ARN: 'arn:apns',
  APNS_TOPIC: 'com.danbut.picket',
};
const NOTIFIER_ENV = {
  PHOTOS_TABLE: 't',
  PHOTOS_BUCKET: 'b',
  STATUS_INDEX: 'byStatus',
  NOTIFY_TABLE: 'n',
  APNS_SECRET_ARN: 'arn:apns',
  APNS_TOPIC: 'com.danbut.picket',
  QUIET_QUEUE_URL: 'https://sqs/q',
  REMINDER_TIME_ZONE: 'America/New_York',
};

const loadWith = async (env: Record<string, string>, entry: string) => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import(entry)) as { handler?: unknown };
};

describe('Lambda entry points load with only their own environment', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('the API handler', async () => {
    expect(typeof (await loadWith(API_ENV, '../src/handler.js')).handler).toBe('function');
  });

  it('the notifier', async () => {
    expect(typeof (await loadWith(NOTIFIER_ENV, '../src/notifier.js')).handler).toBe('function');
  });
});
