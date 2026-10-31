// Mirror of services/api/src/types.ts (the app can't import across packages under Metro).
export type PhotoStatus = 'unreviewed' | 'pick' | 'reject';
export type LightroomStatus = 'queued' | 'uploading' | 'done' | 'duplicate' | 'failed';

export interface LightroomInfo {
  status: LightroomStatus;
  updatedAt: string;
  assetId?: string;
  albumId?: string;
  error?: string;
  attempts?: number;
}

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
  lightroomStatus?: LightroomStatus;
  lightroom?: LightroomInfo;
}

export interface PhotoPage {
  items: Photo[];
  cursor?: string;
}

export interface Stats {
  photos: Record<PhotoStatus, number>;
  lightroom: Record<LightroomStatus, number>;
}

export interface LightroomStatusView {
  connected: boolean;
  email?: string;
  catalogId?: string;
  albumId?: string;
  albumName: string;
  storage?: { used: number; limit: number };
  connectedAt?: string;
  oauth: { clientId: string; scopes: string[]; redirectUri: string; authorizeUrl: string; tokenUrl: string };
}

export interface ReceiverSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  secureProtocol: true;
  passiveMode: true;
  passivePorts: string;
  instanceState: string;
  passwordReload?: 'applied' | 'pending' | 'failed';
}

export type ReceiverPowerAction = 'start' | 'stop';

export interface ConnectRequest {
  refreshToken: string;
  accessToken?: string;
  expiresIn?: number;
}
