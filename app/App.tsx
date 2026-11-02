import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { colors, tint } from './src/lib/theme';
import { loadSettings, type Settings } from './src/lib/settings';
import { createApi, type Api } from './src/lib/api';
import type { Stats } from './src/lib/types';
import { createDemoApi } from './src/lib/demo';
import { warm } from './src/lib/photoStore';
import { onNotificationOpened, registerForPush, setAppBadge, type PushState } from './src/lib/push';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { PicksScreen } from './src/screens/PicksScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

type Tab = 'review' | 'picks' | 'library' | 'settings';
type IconName = keyof typeof Ionicons.glyphMap;
const TABS: { key: Tab; label: string; icon: IconName; iconOn: IconName }[] = [
  { key: 'review', label: 'Review', icon: 'albums-outline', iconOn: 'albums' },
  { key: 'picks', label: 'Picks', icon: 'star-outline', iconOn: 'star' },
  { key: 'library', label: 'Library', icon: 'images-outline', iconOn: 'images' },
  { key: 'settings', label: 'Settings', icon: 'settings-outline', iconOn: 'settings' },
];

/** How often the tab badges re-read the counts while nothing in the app changes them (new shots from the camera). */
const STATS_POLL_MS = 20_000;

/** Calls `changed` after every call that moves a photo between tabs, so the badges follow along. */
function notifying(api: Api, changed: () => void): Api {
  const after =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    (...a: A) => {
      const p = fn(...a);
      p.then(changed, changed);
      return p;
    };
  return { ...api, decide: after(api.decide), sendOne: after(api.sendOne), sendMany: after(api.sendMany) };
}

const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

/** Start in sample-photos mode (no server): the UI-preview workflow exports the web build with this set. */
const DEMO_FROM_ENV = process.env.EXPO_PUBLIC_PICKET_DEMO === '1';
/** Sample photos simulate a phone that already has notifications on. */
const DEMO_PUSH: PushState = { status: 'on', serverReady: true };

export default function App() {
  const [settings, setSettings] = useState<Settings | null | undefined>(undefined);
  const [demo, setDemo] = useState(DEMO_FROM_ENV);
  const [tab, setTab] = useState<Tab>('review');

  useEffect(() => {
    loadSettings().then(setSettings, () => setSettings(null));
  }, []);

  const [stats, setStats] = useState<Stats | null>(null);
  const changedRef = useRef<() => void>(() => undefined);
  const api = useMemo(() => {
    const base = demo ? createDemoApi() : settings ? createApi(settings) : null;
    return base && notifying(base, () => changedRef.current());
  }, [demo, settings]);
  const activeTab: Tab = api ? tab : 'settings';

  const refreshStats = useCallback(() => {
    if (api) api.stats().then(setStats, () => undefined);
  }, [api]);
  // Bursts of decisions (flicking through Review) collapse into one read.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    changedRef.current = () => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(refreshStats, 400);
    };
  }, [refreshStats]);
  useEffect(() => {
    if (!api) {
      setStats(null);
      return;
    }
    refreshStats();
    const t = setInterval(refreshStats, STATS_POLL_MS);
    return () => clearInterval(t);
  }, [api, refreshStats, activeTab]);

  // New-photo notifications: ask once a server is paired (the prompt only ever shows once), then
  // re-register on every launch so a rotated token reaches the server. Sample photos simulate it.
  const [registered, setRegistered] = useState<PushState | null>(null);
  const [demoReminders, setDemoReminders] = useState(true);
  const push: PushState | null = demo ? { ...DEMO_PUSH, reminders: demoReminders } : registered;
  // The weekly reminder is a per-phone setting kept on the server; flip it optimistically.
  const setReminders = useCallback(
    (on: boolean) => {
      if (demo) {
        setDemoReminders(on);
        return;
      }
      const token = registered?.token;
      if (!api || !token) return;
      setRegistered((p) => p && { ...p, reminders: on });
      api.registerDevice(token, { reminders: on }).then(
        (r) => setRegistered((p) => p && { ...p, reminders: r.reminders }),
        () => setRegistered((p) => p && { ...p, reminders: !on }),
      );
    },
    [api, demo, registered?.token],
  );
  const enablePush = useCallback(
    (ask: boolean) => {
      if (api && !demo) void registerForPush(api, { ask }).then(setRegistered);
    },
    [api, demo],
  );
  useEffect(() => enablePush(true), [enablePush]);
  // Coming back to the app: clear Picket's notifications (they've been seen) and re-register, so a
  // rotated push token reaches the server.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') enablePush(false);
    });
    return () => sub.remove();
  }, [enablePush]);
  const openReview = useCallback(() => setTab('review'), []);
  useEffect(() => onNotificationOpened(openReview), [openReview]);
  const unreviewed = stats?.photos.unreviewed;
  useEffect(() => {
    if (unreviewed !== undefined && !demo) setAppBadge(unreviewed);
  }, [unreviewed, demo]);

  const badges: Partial<Record<Tab, { count: number; alert?: boolean }>> = stats
    ? {
        review: { count: stats.photos.unreviewed ?? 0 },
        picks: { count: stats.photos.pick ?? 0, alert: (stats.lightroom.failed ?? 0) > 0 },
      }
    : {};

  // Bring the Skipped / Sent / Picks caches up to date once Review has had its turn, and again
  // whenever the app comes back to the foreground (another phone may have changed things).
  useEffect(() => {
    if (!api) return;
    const t = setTimeout(() => void warm(api), 2500);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void warm(api);
    });
    return () => {
      clearTimeout(t);
      sub.remove();
    };
  }, [api]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
          <StatusBar style="light" />
          {settings === undefined && !demo ? (
            <ActivityIndicator style={{ flex: 1 }} color={colors.accent} />
          ) : activeTab === 'review' && api ? (
            <ReviewScreen api={api} />
          ) : activeTab === 'picks' && api ? (
            <PicksScreen api={api} />
          ) : activeTab === 'library' && api ? (
            <LibraryScreen api={api} />
          ) : (
            <SettingsScreen
              initial={settings ?? null}
              api={api}
              demo={demo}
              push={push}
              onEnablePush={() => enablePush(true)}
              onReminders={setReminders}
              onDemo={(on) => {
                setDemo(on);
                setTab(on ? 'review' : 'settings');
              }}
              onSaved={(s) => {
                setSettings(s);
                setDemo(false);
                if (s) setTab('review');
              }}
            />
          )}
          <View style={styles.tabs} accessibilityRole="tablist">
            {TABS.map((t) => {
              const active = activeTab === t.key;
              const disabled = !api && t.key !== 'settings';
              const badge = badges[t.key];
              const tone = active ? colors.accent : colors.muted;
              return (
                <Pressable
                  key={t.key}
                  onPress={() => setTab(t.key)}
                  disabled={disabled}
                  style={[styles.tab, disabled && styles.tabDisabled]}
                  testID={`tab-${t.key}`}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active, disabled }}
                  accessibilityLabel={badge?.count ? `${t.label}, ${badge.count}` : t.label}
                >
                  <View style={[styles.pill, active && styles.pillActive]}>
                    <Ionicons name={active ? t.iconOn : t.icon} size={22} color={tone} />
                    {!!badge?.count && (
                      <View style={[styles.badge, badge.alert && styles.badgeAlert]} testID={`badge-${t.key}`}>
                        <Text style={styles.badgeText}>{badgeText(badge.count)}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={[styles.tabText, { color: active ? colors.text : colors.muted }]} numberOfLines={1}>
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  tabs: { flexDirection: 'row', paddingTop: 8, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.bg },
  tab: { flex: 1, alignItems: 'center', gap: 4 },
  pill: { width: 56, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  pillActive: { backgroundColor: tint(colors.accent, 0.18) },
  badge: {
    position: 'absolute',
    top: -4,
    left: 34,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bg,
  },
  badgeAlert: { backgroundColor: colors.danger },
  badgeText: { color: colors.onFill, fontSize: 10, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tabText: { fontWeight: '600', fontSize: 11 },
  tabDisabled: { opacity: 0.4 },
});
