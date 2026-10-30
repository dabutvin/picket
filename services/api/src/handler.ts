import { createApp } from './app.js';
import { createStore } from './store.js';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

export const handler = createApp(
  createStore({
    tableName: env('PHOTOS_TABLE'),
    statusIndex: process.env.STATUS_INDEX ?? 'byStatus',
    bucket: env('PHOTOS_BUCKET'),
  }),
);
