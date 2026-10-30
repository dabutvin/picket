// Mirror of services/api/src/types.ts (the app can't import across packages under Metro).
export type PhotoStatus = 'unreviewed' | 'pick' | 'reject';

export interface Photo {
  photoId: string;
  status: PhotoStatus;
  capturedAt: string;
  uploadedAt: string;
  decidedAt?: string;
  rawKey: string;
  fileName: string;
  previewKey: string;
  thumbKey: string;
  previewUrl: string;
  thumbUrl: string;
  width?: number;
  height?: number;
  bytes?: number;
  camera?: string;
  lens?: string;
  iso?: string;
  shutter?: string;
  aperture?: string;
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
