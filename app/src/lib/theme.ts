import { Platform } from 'react-native';

export const colors = {
  bg: '#0b0b0d',
  card: '#16161a',
  text: '#f2f2f2',
  muted: '#8a8a93',
  pick: '#34c77b',
  reject: '#ff6b5e',
  accent: '#6aa6ff',
  border: '#2a2a31',
  /** Text on a filled accent/pick/reject button. */
  onFill: '#0b0b0d',
} as const;

/** A 6-digit hex colour at the given opacity (8-digit hex works on iOS, Android and web). */
export function tint(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex.slice(0, 7)}${a}`;
}

/** Menlo on iOS; the web build falls back to the browser's monospace font. */
export const MONO = Platform.select({ web: 'Menlo, monospace', default: 'Menlo' }) as string;
