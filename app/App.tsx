import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { colors } from './src/lib/theme';
import { loadSettings, type Settings } from './src/lib/settings';
import { createApi } from './src/lib/api';
import { ReviewScreen } from './src/screens/ReviewScreen';
import { PicksScreen } from './src/screens/PicksScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

type Tab = 'review' | 'picks' | 'settings';
const TABS: { key: Tab; label: string }[] = [
  { key: 'review', label: 'Review' },
  { key: 'picks', label: 'Picks' },
  { key: 'settings', label: 'Settings' },
];

export default function App() {
  const [settings, setSettings] = useState<Settings | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('review');

  useEffect(() => {
    loadSettings().then(setSettings, () => setSettings(null));
  }, []);

  const api = useMemo(() => (settings ? createApi(settings) : null), [settings]);
  const activeTab: Tab = api ? tab : 'settings';

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
          <StatusBar style="light" />
          {settings === undefined ? (
            <ActivityIndicator style={{ flex: 1 }} color={colors.accent} />
          ) : activeTab === 'review' && api ? (
            <ReviewScreen api={api} />
          ) : activeTab === 'picks' && api ? (
            <PicksScreen api={api} />
          ) : (
            <SettingsScreen
              initial={settings}
              onSaved={(s) => {
                setSettings(s);
                if (s) setTab('review');
              }}
            />
          )}
          <View style={styles.tabs}>
            {TABS.map((t) => (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                disabled={!api && t.key !== 'settings'}
                style={styles.tab}
              >
                <Text style={[styles.tabText, activeTab === t.key && styles.tabActive, !api && t.key !== 'settings' && styles.tabDisabled]}>
                  {t.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabText: { color: colors.muted, fontWeight: '600' },
  tabActive: { color: colors.text },
  tabDisabled: { opacity: 0.4 },
});
