import { Linking, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { Api } from './api';

/**
 * New-photo notifications (ADR-010). The server pushes straight to Apple, so the app hands it the
 * raw APNs device token (not an Expo push token). iOS only; the web build and sample photos never
 * ask for permission.
 *
 * - `unsupported`: web (or Android, which Picket doesn't ship).
 * - `undetermined`: never asked.
 * - `denied`: turned off in iOS Settings; only the Settings app can turn it back on.
 * - `on`: allowed and this phone's token is registered with the API.
 * - `error`: allowed, but registering with the API failed (offline, older stack).
 */
export type PushStatus = 'unsupported' | 'undetermined' | 'denied' | 'on' | 'error';

export interface PushState {
  status: PushStatus;
  /** The server has an APNs key; without it registration works but nothing is sent. */
  serverReady?: boolean;
  error?: string;
}

const supported = Platform.OS === 'ios';

if (supported) {
  // A push that arrives while the app is open still shows as a banner (the badge is set by the app).
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

// Picket asks for full (not provisional) authorization, so `granted` is the whole answer.
const allowed = (p: Notifications.NotificationPermissionsStatus) => p.granted;

/**
 * Register this phone for pushes. With `ask`, shows the iOS permission prompt if it was never
 * shown; without, only registers when permission is already there (every launch, which also
 * refreshes a rotated token).
 */
export async function registerForPush(api: Api, { ask }: { ask: boolean }): Promise<PushState> {
  if (!supported) return { status: 'unsupported' };
  let perm = await Notifications.getPermissionsAsync();
  if (!allowed(perm) && perm.canAskAgain && ask) {
    perm = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
  }
  if (!allowed(perm)) return { status: perm.canAskAgain ? 'undetermined' : 'denied' };
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    const res = await api.registerDevice(String(token.data));
    return { status: 'on', serverReady: res.configured };
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Mirror the Review count on the app icon (pushes set it too, but deciding photos should lower it). */
export function setAppBadge(count: number) {
  if (supported) void Notifications.setBadgeCountAsync(count).catch(() => undefined);
}

/** Calls `onOpen` when a notification is tapped (including the one that launched the app). */
export function onNotificationOpened(onOpen: () => void): () => void {
  if (!supported) return () => undefined;
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    if (r) {
      onOpen();
      void Notifications.clearLastNotificationResponseAsync();
    }
  });
  const sub = Notifications.addNotificationResponseReceivedListener(() => onOpen());
  return () => sub.remove();
}

export const openSystemSettings = () => void Linking.openSettings();
