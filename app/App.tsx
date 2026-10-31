import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { colors } from './src/lib/theme';
import { loadSettings, type Settings } from './src/lib/settings';
import { createApi } from './src/lib/api';
import { createDemoApi } from './src/lib/demo';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { PicksScreen } from './src/screens/PicksScreen';
import { SentScreen } from './src/screens/SentScreen';
import { SkippedScreen } from './src/screens/SkippedScreen';
import { CameraScreen } from './src/screens/CameraScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

type Tab = 'review' | 'picks' | 'sent' | 'skipped' | 'camera' | 'settings';
const TABS: { key: Tab; label: string }[] = [
  { key: 'review', label: 'Review' },
  { key: 'picks', label: 'Picks' },
  { key: 'sent', label: 'Sent' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'camera', label: 'Camera' },
  { key: 'settings', label: 'Settings' },
];

/** Start in sample-photos mode (no server): the UI-preview workflow exports the web build with this set. */
const DEMO_FROM_ENV = process.env.EXPO_PUBLIC_PICKET_DEMO === '1';

export default function App() {
  const [settings, setSettings] = useState<Settings | null | undefined>(undefined);
  const [demo, setDemo] = useState(DEMO_FROM_ENV);
  const [tab, setTab] = useState<Tab>('review');

  useEffect(() => {
    loadSettings().then(setSettings, () => setSettings(null));
  }, []);

  const api = useMemo(() => (demo ? createDemoApi() : settings ? createApi(settings) : null), [demo, settings]);
  const activeTab: Tab = api ? tab : 'settings';

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
          ) : activeTab === 'sent' && api ? (
            <SentScreen api={api} />
          ) : activeTab === 'skipped' && api ? (
            <SkippedScreen api={api} />
          ) : activeTab === 'camera' && api ? (
            <CameraScreen api={api} />
          ) : (
            <SettingsScreen
              initial={settings ?? null}
              api={api}
              demo={demo}
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
          <View style={styles.tabs}>
            {TABS.map((t) => {
              const active = activeTab === t.key;
              const disabled = !api && t.key !== 'settings';
              return (
                <Pressable key={t.key} onPress={() => setTab(t.key)} disabled={disabled} style={styles.tab} testID={`tab-${t.key}`}>
                  <View style={[styles.tabIndicator, active && styles.tabIndicatorActive]} />
                  <Text style={[styles.tabText, active && styles.tabActive, disabled && styles.tabDisabled]} numberOfLines={1}>
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
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  tab: { flex: 1, paddingBottom: 10, alignItems: 'center', gap: 8 },
  tabIndicator: { height: 2, width: 24, borderRadius: 1, backgroundColor: 'transparent' },
  tabIndicatorActive: { backgroundColor: colors.accent },
  tabText: { color: colors.muted, fontWeight: '600', fontSize: 12 },
  tabActive: { color: colors.text },
  tabDisabled: { opacity: 0.4 },
});
