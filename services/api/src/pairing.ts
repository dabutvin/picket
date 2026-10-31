/**
 * App pairing without anyone handling the bearer token. The deploy / ops workflow
 * writes a short-lived, single-use code into Secrets Manager and prints it; the app
 * exchanges it for the token over POST /pair (the only unauthenticated route).
 */
import { timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export interface PairingRecord {
  code: string;
  expiresAt: string;
  usedAt?: string;
}

export interface PairingStore {
  load(): Promise<PairingRecord | null>;
  save(record: PairingRecord): Promise<void>;
  apiToken(): Promise<string>;
}

export function createPairingStore(pairingSecretId: string, tokenSecretId: string, client = new SecretsManagerClient({})): PairingStore {
  return {
    async load() {
      const res = await client.send(new GetSecretValueCommand({ SecretId: pairingSecretId }));
      if (!res.SecretString) return null;
      const parsed = JSON.parse(res.SecretString) as Partial<PairingRecord>;
      return parsed.code && parsed.expiresAt ? (parsed as PairingRecord) : null;
    },
    async save(record) {
      await client.send(new PutSecretValueCommand({ SecretId: pairingSecretId, SecretString: JSON.stringify(record) }));
    },
    async apiToken() {
      const res = await client.send(new GetSecretValueCommand({ SecretId: tokenSecretId }));
      if (!res.SecretString) throw new Error('api token secret is empty');
      return res.SecretString;
    },
  };
}

export function createMemoryPairingStore(initial: PairingRecord | null, token = 'tok'): PairingStore {
  let value = initial;
  return {
    load: async () => value,
    save: async (r) => {
      value = r;
    },
    apiToken: async () => token,
  };
}

/** Codes are shown as XXXX-XXXX; compare case- and dash-insensitively. */
export const normalizeCode = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export type PairOutcome = { ok: true; token: string } | { ok: false; reason: 'invalid' | 'expired' | 'used' };

export async function redeemPairingCode(store: PairingStore, presented: string, now: () => number = Date.now): Promise<PairOutcome> {
  const record = await store.load();
  const a = Buffer.from(normalizeCode(presented));
  const b = Buffer.from(normalizeCode(record?.code ?? ''));
  const matches = record !== null && a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  if (!matches) return { ok: false, reason: 'invalid' };
  if (record!.usedAt) return { ok: false, reason: 'used' };
  if (Date.parse(record!.expiresAt) < now()) return { ok: false, reason: 'expired' };
  await store.save({ ...record!, usedAt: new Date(now()).toISOString() });
  return { ok: true, token: await store.apiToken() };
}
