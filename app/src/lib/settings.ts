import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const KEYS = { apiUrl: 'picket.apiUrl', token: 'picket.token' } as const;

export interface Settings {
  apiUrl: string;
  token: string;
}

// SecureStore has no web implementation; the web build (UI previews, Expo web) keeps the
// pairing in localStorage instead.
const store =
  Platform.OS === 'web'
    ? {
        get: async (k: string) => globalThis.localStorage?.getItem(k) ?? null,
        set: async (k: string, v: string) => globalThis.localStorage?.setItem(k, v),
        del: async (k: string) => globalThis.localStorage?.removeItem(k),
      }
    : { get: SecureStore.getItemAsync, set: SecureStore.setItemAsync, del: SecureStore.deleteItemAsync };

export async function loadSettings(): Promise<Settings | null> {
  const [apiUrl, token] = await Promise.all([store.get(KEYS.apiUrl), store.get(KEYS.token)]);
  return apiUrl && token ? { apiUrl, token } : null;
}

export async function saveSettings(s: Settings): Promise<void> {
  await Promise.all([store.set(KEYS.apiUrl, s.apiUrl.trim().replace(/\/+$/, '')), store.set(KEYS.token, s.token.trim())]);
}

export async function clearSettings(): Promise<void> {
  await Promise.all([store.del(KEYS.apiUrl), store.del(KEYS.token)]);
}
