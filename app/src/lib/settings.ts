import * as SecureStore from 'expo-secure-store';

const KEYS = { apiUrl: 'picket.apiUrl', token: 'picket.token' } as const;

export interface Settings {
  apiUrl: string;
  token: string;
}

export async function loadSettings(): Promise<Settings | null> {
  const [apiUrl, token] = await Promise.all([
    SecureStore.getItemAsync(KEYS.apiUrl),
    SecureStore.getItemAsync(KEYS.token),
  ]);
  return apiUrl && token ? { apiUrl, token } : null;
}

export async function saveSettings(s: Settings): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.apiUrl, s.apiUrl.trim().replace(/\/+$/, '')),
    SecureStore.setItemAsync(KEYS.token, s.token.trim()),
  ]);
}

export async function clearSettings(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(KEYS.apiUrl), SecureStore.deleteItemAsync(KEYS.token)]);
}
