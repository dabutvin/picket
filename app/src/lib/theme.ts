import { Platform } from 'react-native';

export const colors = {
  bg: '#0b0b0d',
  card: '#16161a',
  text: '#f2f2f2',
  muted: '#8a8a93',
  pick: '#3ddc84',
  reject: '#ff5c5c',
  accent: '#6aa6ff',
  border: '#2a2a31',
} as const;

/** Menlo on iOS; the web build falls back to the browser's monospace font. */
export const MONO = Platform.select({ web: 'Menlo, monospace', default: 'Menlo' }) as string;
