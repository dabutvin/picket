export type PhotoStatus = 'unreviewed' | 'pick' | 'reject';
export const PHOTO_STATUSES: readonly PhotoStatus[] = ['unreviewed', 'pick', 'reject'];

/** One row of the Photos table, as written by services/preview. */
export interface PhotoItem {
  photoId: string;
  status: PhotoStatus;
  capturedAt: string;
  uploadedAt: string;
  processedAt?: string;
  decidedAt?: string;
  rawKey: string;
  fileName: string;
  previewKey: string;
  thumbKey: string;
  width?: number;
  height?: number;
  bytes?: number;
  camera?: string;
  lens?: string;
  iso?: string;
  shutter?: string;
  aperture?: string;
}

/** What the app receives: the item plus short-lived URLs. */
export interface Photo extends PhotoItem {
  previewUrl: string;
  thumbUrl: string;
}

export interface PhotoPage {
  items: Photo[];
  cursor?: string;
}

export interface RawUrl {
  url: string;
  fileName: string;
  bytes?: number;
  expiresInSeconds: number;
}
