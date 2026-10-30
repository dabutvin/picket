import type { LightroomConfig } from './app.js';

export const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

export const DEFAULT_SCOPES = ['openid', 'AdobeID', 'lr_partner_apis', 'lr_partner_rendition_apis', 'offline_access'];

export function lightroomConfigFromEnv(): LightroomConfig {
  return {
    clientId: process.env.LIGHTROOM_CLIENT_ID ?? '',
    redirectUri: process.env.LIGHTROOM_REDIRECT_URI ?? '',
    scopes: (process.env.LIGHTROOM_SCOPES ?? DEFAULT_SCOPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    albumName: process.env.LIGHTROOM_ALBUM_NAME ?? 'Picket',
  };
}
