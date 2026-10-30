import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { refreshTokens, type FetchFn } from './adobe.js';
import type { LightroomConnection } from './types.js';

/** Where the one user's Lightroom tokens live. Backed by Secrets Manager in production. */
export interface ConnectionStore {
  load(): Promise<LightroomConnection | null>;
  save(conn: LightroomConnection): Promise<void>;
  clear(): Promise<void>;
}

export function createSecretsConnectionStore(secretId: string, client = new SecretsManagerClient({})): ConnectionStore {
  return {
    async load() {
      const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (!res.SecretString) return null;
      const parsed = JSON.parse(res.SecretString) as Partial<LightroomConnection>;
      return parsed.refreshToken ? (parsed as LightroomConnection) : null;
    },
    async save(conn) {
      await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify(conn) }));
    },
    async clear() {
      await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: '{}' }));
    },
  };
}

export function createMemoryConnectionStore(initial: LightroomConnection | null = null): ConnectionStore {
  let value = initial;
  return {
    load: async () => value,
    save: async (c) => {
      value = c;
    },
    clear: async () => {
      value = null;
    },
  };
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Return a usable access token, refreshing (and persisting the rotated refresh
 * token) when the cached one is missing or within 5 minutes of expiry.
 */
export async function ensureAccessToken(
  store: ConnectionStore,
  conn: LightroomConnection,
  fetchFn: FetchFn,
  clientId: string,
  now: () => number = Date.now,
): Promise<{ accessToken: string; conn: LightroomConnection }> {
  if (conn.accessToken && conn.expiresAt && Date.parse(conn.expiresAt) - now() > REFRESH_MARGIN_MS) {
    return { accessToken: conn.accessToken, conn };
  }
  const t = await refreshTokens(fetchFn, clientId, conn.refreshToken);
  const next: LightroomConnection = { ...conn, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt };
  await store.save(next);
  return { accessToken: t.accessToken, conn: next };
}
