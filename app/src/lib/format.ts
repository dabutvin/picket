import type { Photo } from './types';

/** "1/250 · f/2.8 · ISO 400 · FE 35mm F1.8", whatever EXIF gave us. */
export const exifLine = (p: Photo): string => [p.shutter, p.aperture, p.iso && `ISO ${p.iso}`, p.lens].filter(Boolean).join(' · ');

/** Capture time as the camera clock saw it (capturedAt carries no zone), short enough for a strip. */
export function captureTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const megabytes = (bytes: number | undefined): string => (bytes ? `${(bytes / 1e6).toFixed(1)} MB` : '');

/** Lightroom already has it or is about to. */
export const onItsWay = (p: Photo): boolean => p.lightroom?.status === 'queued' || p.lightroom?.status === 'uploading';
