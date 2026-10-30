import { createApp } from './app.js';
import { createSecretsConnectionStore } from './connection.js';
import { env, lightroomConfigFromEnv } from './config.js';
import { createStore } from './store.js';

export const handler = createApp({
  store: createStore({
    tableName: env('PHOTOS_TABLE'),
    statusIndex: process.env.STATUS_INDEX ?? 'byStatus',
    lightroomIndex: process.env.LIGHTROOM_INDEX ?? 'byLightroomStatus',
    bucket: env('PHOTOS_BUCKET'),
  }),
  connections: createSecretsConnectionStore(env('LIGHTROOM_SECRET_ARN')),
  lightroom: lightroomConfigFromEnv(),
});
