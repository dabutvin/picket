import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, MONO } from '../lib/theme';
import { saveSettings, clearSettings, type Settings } from '../lib/settings';
import { createApi, pair, type Api } from '../lib/api';
import type { LightroomStatusView } from '../lib/types';
import { loginToAdobe } from '../lib/adobeAuth';
import { Button } from '../components/Button';

interface Props {
  initial: Settings | null;
  api: Api | null;
  /** Running against the in-app sample photos instead of a server. */
  demo: boolean;
  onDemo: (on: boolean) => void;
  onSaved: (s: Settings | null) => void;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function SettingsScreen({ initial, api, demo, onDemo, onSaved }: Props) {
  const [apiUrl, setApiUrl] = useState(initial?.apiUrl ?? '');
  const [code, setCode] = useState('');
  const [testing, setTesting] = useState(false);
  const [lr, setLr] = useState<LightroomStatusView | null>(null);
  const [lrBusy, setLrBusy] = useState(false);

  useEffect(() => {
    if (!api) return;
    api.lightroom().then(setLr, () => setLr(null));
  }, [api]);

  const save = async () => {
    const url = apiUrl.trim().replace(/\/+$/, '');
    if (!/^https:\/\//.test(url)) {
      Alert.alert('Check the API URL', 'It must start with https:// (the ApiUrl value from the deploy summary).');
      return;
    }
    const trimmed = code.trim();
    if (!trimmed && !initial?.token) {
      Alert.alert('Pairing code needed', 'Run the deploy or ops → pairing-code workflow and type the code it shows.');
      return;
    }
    setTesting(true);
    try {
      const token = trimmed ? await pair(url, trimmed) : initial!.token;
      const s = { apiUrl: url, token };
      await createApi(s).list('unreviewed', 1);
      await saveSettings(s);
      setCode('');
      onSaved(s);
    } catch (e) {
      Alert.alert('Could not pair', e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const connect = async () => {
    if (!api || !lr) return;
    setLrBusy(true);
    try {
      const r = await loginToAdobe(lr.oauth);
      if (r.type === 'cancel') return;
      if (r.type === 'error') {
        Alert.alert('Adobe login failed', r.message);
        return;
      }
      setLr(await api.connectLightroom(r.tokens));
    } catch (e) {
      Alert.alert('Could not connect Lightroom', e instanceof Error ? e.message : String(e));
    } finally {
      setLrBusy(false);
    }
  };

  const disconnect = () => {
    if (!api) return;
    Alert.alert('Disconnect Lightroom?', 'Queued picks will fail until you connect again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: () => {
          api.disconnectLightroom().then(setLr, (e: unknown) => Alert.alert('Error', e instanceof Error ? e.message : String(e)));
        },
      },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.root} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Settings</Text>

      {demo && (
        <View style={[styles.card, styles.demoCard]}>
          <Text style={styles.cardTitle}>Sample photos</Text>
          <Text style={styles.help}>You are looking at built-in sample photos. Nothing here talks to a server or to Lightroom.</Text>
          <Button title="Leave sample photos" color={colors.muted} onPress={() => onDemo(false)} testID="demo-leave" />
        </View>
      )}

      <Text style={styles.section}>Picket API</Text>
      <Text style={styles.help}>
        The deploy workflow's summary shows the <Text style={styles.code}>ApiUrl</Text> and a one-time pairing code.
        {initial ? ' Paired. Enter a new code only to re-pair.' : ''}
      </Text>
      <Text style={styles.label}>API URL</Text>
      <TextInput
        value={apiUrl}
        onChangeText={setApiUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://api.picket.photos"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      <Text style={styles.label}>Pairing code</Text>
      <TextInput
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="XXXX-XXXX"
        placeholderTextColor={colors.muted}
        style={[styles.input, styles.mono]}
      />
      <Button title={testing ? 'Pairing…' : initial ? 'Save' : 'Pair'} onPress={() => void save()} disabled={testing} />
      {!demo && !initial && (
        <>
          <Text style={[styles.help, { textAlign: 'center' }]}>Not paired yet? Try the app with sample photos.</Text>
          <Button title="Try with sample photos" color={colors.muted} onPress={() => onDemo(true)} testID="demo-enter" />
        </>
      )}

      {api && (
        <>
          <Text style={styles.section}>Lightroom</Text>
          {lr === null ? (
            <ActivityIndicator color={colors.accent} />
          ) : lr.connected ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Connected as {lr.email}</Text>
              {lr.storage && (
                <Text style={styles.help}>
                  {gb(lr.storage.used)} of {gb(lr.storage.limit)} used
                </Text>
              )}
              <Text style={styles.help}>Picks land in the “{lr.albumName}” album.</Text>
              <View style={styles.row}>
                <Button title="Refresh" color={colors.muted} onPress={() => void api.refreshLightroom().then(setLr)} />
                <Button title="Disconnect" color={colors.reject} onPress={disconnect} />
              </View>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.help}>
                Sign in with the Adobe account that owns your Lightroom catalog. Picks are uploaded from the server; RAW files never
                touch this phone.
              </Text>
              {!lr.oauth.clientId && (
                <Text style={[styles.help, { color: colors.reject }]}>The server has no Lightroom client id yet (deploy with LIGHTROOM_CLIENT_ID).</Text>
              )}
              <Button
                title={lrBusy ? 'Waiting for Adobe…' : 'Connect Lightroom'}
                onPress={() => void connect()}
                disabled={lrBusy || !lr.oauth.clientId || !lr.oauth.redirectUri}
              />
              <Text style={styles.fine}>Redirect URI: {lr.oauth.redirectUri || '(not configured)'}</Text>
            </View>
          )}
        </>
      )}

      {initial && (
        <Button
          title="Sign out of Picket"
          color={colors.reject}
          onPress={() => {
            void clearSettings().then(() => onSaved(null));
          }}
          style={{ marginTop: 24 }}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  section: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 16 },
  help: { color: colors.muted, lineHeight: 20 },
  fine: { color: colors.muted, fontSize: 11 },
  code: { color: colors.text, fontFamily: MONO },
  mono: { fontFamily: MONO, letterSpacing: 2 },
  label: { color: colors.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginTop: 8 },
  input: {
    color: colors.text,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
  },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.border },
  demoCard: { borderColor: colors.accent },
  cardTitle: { color: colors.text, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10 },
});
