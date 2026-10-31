/**
 * Where a photo is in the review flow. `sent` means Lightroom has it; the uploader
 * sets it (and only it) once an upload ends as done or duplicate.
 */
export type PhotoStatus = 'unreviewed' | 'pick' | 'reject' | 'sent';
export const PHOTO_STATUSES: readonly PhotoStatus[] = ['unreviewed', 'pick', 'reject', 'sent'];

/** What a swipe (or a grid action) may set. `sent` is never a decision. */
export type Decision = Exclude<PhotoStatus, 'sent'>;
export const DECISIONS: readonly Decision[] = ['unreviewed', 'pick', 'reject'];

/** Where a pick is on its way into the Lightroom cloud catalog. */
export type LightroomStatus = 'queued' | 'uploading' | 'done' | 'duplicate' | 'failed';
export const LIGHTROOM_STATUSES: readonly LightroomStatus[] = ['queued', 'uploading', 'done', 'duplicate', 'failed'];

export interface LightroomInfo {
  status: LightroomStatus;
  updatedAt: string;
  /** Lightroom asset id (GUID without hyphens) once created. */
  assetId?: string;
  albumId?: string;
  error?: string;
  attempts?: number;
}

/** One row of the Photos table, as written by services/preview and updated here. */
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
  /** Duplicated top-level for the byLightroomStatus index. */
  lightroomStatus?: LightroomStatus;
  lightroom?: LightroomInfo;
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

export interface Stats {
  photos: Record<PhotoStatus, number>;
  lightroom: Record<LightroomStatus, number>;
}

/** Stored in Secrets Manager. Never returned to the app. */
export interface LightroomConnection {
  refreshToken: string;
  accessToken?: string;
  /** ISO time the access token expires. */
  expiresAt?: string;
  catalogId?: string;
  albumId?: string;
  email?: string;
  accountId?: string;
  storage?: { used: number; limit: number };
  connectedAt: string;
}

/** What the app sees. */
export interface LightroomStatusView {
  connected: boolean;
  email?: string;
  catalogId?: string;
  albumId?: string;
  albumName: string;
  storage?: { used: number; limit: number };
  connectedAt?: string;
  /** OAuth config the app needs to start the PKCE flow. */
  oauth: { clientId: string; scopes: string[]; redirectUri: string; authorizeUrl: string; tokenUrl: string };
}

/** What the camera needs, read from the app's Camera screen. */
export interface ReceiverSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  secureProtocol: true;
  passiveMode: true;
  passivePorts: string;
  /** EC2 state: running, stopped, pending, stopping... */
  instanceState: string;
  /** After a rotation: whether the receiver has picked the new password up. */
  passwordReload?: 'applied' | 'pending' | 'failed';
}

export type ReceiverPowerAction = 'start' | 'stop';

/** POST /lightroom/send: queue these picks, or every pick that is not already on its way. */
export interface SendRequest {
  photoIds?: string[];
  all?: boolean;
}

export interface SendResult {
  /** Picks now queued (with fresh URLs). */
  photos: Photo[];
  /** Ids that were not queued: not a pick, already uploading, or already in Lightroom. */
  skipped: string[];
}

export interface ConnectRequest {
  refreshToken: string;
  accessToken?: string;
  /** Seconds, as returned by IMS. */
  expiresIn?: number;
}
