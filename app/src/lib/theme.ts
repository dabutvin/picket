import { Platform } from 'react-native';

/**
 * One palette built around the violet accent: the greys lean slightly violet so every surface
 * belongs with it, and pick/skip are emerald and rose, which sit beside violet without fighting it.
 */
export const colors = {
  bg: '#0d0c12',
  card: '#17151f',
  /** Buttons and controls that sit on `bg` or `card`; a step lighter than `card`. */
  raised: '#24212f',
  text: '#f4f2fa',
  muted: '#9b97aa',
  pick: '#34d399',
  reject: '#fb7185',
  accent: '#a78bfa',
  border: '#2c2939',
  /** Text on a filled accent/pick/reject button. */
  onFill: '#140f22',
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
