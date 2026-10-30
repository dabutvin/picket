import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from '../lib/theme';
import { saveSettings, clearSettings, type Settings } from '../lib/settings';
import { createApi, type Api } from '../lib/api';
import type { LightroomStatusView } from '../lib/types';
import { REDIRECT_URI, loginToAdobe } from '../lib/adobeAuth';
import { Button } from '../components/Button';

interface Props {
  initial: Settings | null;
  api: Api | null;
  onSaved: (s: Settings | null) => void;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export function SettingsScreen({ initial, api, onSaved }: Props) {
  const [apiUrl, setApiUrl] = useState(initial?.apiUrl ?? '');
  const [token, setToken] = useState(initial?.token ?? '');
  const [testing, setTesting] = useState(false);
  const [lr, setLr] = useState<LightroomStatusView | null>(null);
  const [lrBusy, setLrBusy] = useState(false);

  useEffect(() => {
    if (!api) return;
    api.lightroom().then(setLr, () => setLr(null));
  }, [api]);

  const save = async () => {
    const s = { apiUrl: apiUrl.trim().replace(/\/+$/, ''), token: token.trim() };
    if (!/^https:\/\//.test(s.apiUrl) || !s.token) {
      Alert.alert('Check the values', 'The API URL must start with https:// and the token cannot be empty.');
      return;
    }
    setTesting(true);
    try {
      await createApi(s).list('unreviewed', 1);
      await saveSettings(s);
      onSaved(s);
    } catch (e) {
      Alert.alert('Could not reach the API', e instanceof Error ? e.message : String(e));
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

      <Text style={styles.section}>Picket API</Text>
      <Text style={styles.help}>
        Both values come from the CDK outputs: <Text style={styles.code}>ApiUrl</Text> and the value of the{' '}
        <Text style={styles.code}>ApiTokenSecret</Text> secret.
      </Text>
      <Text style={styles.label}>API URL</Text>
      <TextInput
        value={apiUrl}
        onChangeText={setApiUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://xxxxx.execute-api.us-east-1.amazonaws.com"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      <Text style={styles.label}>Token</Text>
      <TextInput
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder="paste the bearer token"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      <Button title={testing ? 'Checking…' : 'Save'} onPress={() => void save()} disabled={testing} />

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
                disabled={lrBusy || !lr.oauth.clientId}
              />
              <Text style={styles.fine}>Redirect URI: {REDIRECT_URI}</Text>
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
  code: { color: colors.text, fontFamily: 'Menlo' },
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
  cardTitle: { color: colors.text, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10 },
});
