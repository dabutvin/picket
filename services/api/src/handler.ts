import { createApp } from './app.js';
import { createSecretsConnectionStore } from './connection.js';
import { env, lightroomConfigFromEnv } from './config.js';
import { createStore } from './store.js';
import { createReceiverCloud, createReceiverService } from './receiver.js';

export const handler = createApp({
  store: createStore({
    tableName: env('PHOTOS_TABLE'),
    statusIndex: process.env.STATUS_INDEX ?? 'byStatus',
    lightroomIndex: process.env.LIGHTROOM_INDEX ?? 'byLightroomStatus',
    bucket: env('PHOTOS_BUCKET'),
  }),
  connections: createSecretsConnectionStore(env('LIGHTROOM_SECRET_ARN')),
  lightroom: lightroomConfigFromEnv(),
  receiver: (() => {
    const cfg = {
      host: env('RECEIVER_HOST'),
      user: env('RECEIVER_FTP_USER'),
      passiveMin: Number(process.env.RECEIVER_PASV_MIN ?? 30000),
      passiveMax: Number(process.env.RECEIVER_PASV_MAX ?? 30009),
      passwordSecretId: env('RECEIVER_PASSWORD_SECRET_ARN'),
      instanceId: env('RECEIVER_INSTANCE_ID'),
    };
    return createReceiverService(cfg, createReceiverCloud(cfg));
  })(),
});
