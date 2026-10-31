import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { ApiError, type Api } from '../lib/api';
import type { ReceiverSettings } from '../lib/types';
import { colors } from '../lib/theme';
import { Button } from '../components/Button';

const fail = (what: string) => (e: unknown) => Alert.alert(what, e instanceof Error ? e.message : String(e));

/** Everything the a7C II's FTP menu asks for, plus the receiver's power switch. */
export function CameraScreen({ api }: { api: Api }) {
  const [settings, setSettings] = useState<ReceiverSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [custom, setCustom] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [notDeployed, setNotDeployed] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api.receiver().then(
        (s) => {
          setNotDeployed(null);
          setSettings(s);
        },
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 503) setNotDeployed(e.message);
          else fail('Could not load receiver settings')(e);
        },
      ),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // While the instance is changing state, poll until it settles.
  useEffect(() => {
    if (!settings || !['pending', 'stopping', 'shutting-down'].includes(settings.instanceState)) return;
    const t = setTimeout(() => void load(), 5000);
    return () => clearTimeout(t);
  }, [settings, load]);

  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const rotate = (password?: string) => {
    Alert.alert(
      password ? 'Set this password?' : 'Generate a new password?',
      'The receiver switches immediately; update the camera afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Change',
          style: 'destructive',
          onPress: () => {
            setBusy('password');
            api
              .rotateReceiverPassword(password)
              .then((s) => {
                setSettings(s);
                setCustom('');
                setShowPassword(true);
                if (s.passwordReload === 'failed') Alert.alert('Saved, but the receiver did not reload', 'Run ops → reload-ftp-password, or restart the receiver.');
              }, fail('Could not change the password'))
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  };

  const power = (action: 'start' | 'stop') => {
    setBusy(action);
    api
      .receiverPower(action)
      .then(setSettings, fail(`Could not ${action} the receiver`))
      .finally(() => setBusy(null));
  };

  if (notDeployed) {
    return (
      <View style={[styles.root, { justifyContent: 'center', gap: 16 }]}>
        <Text style={styles.title}>Camera</Text>
        <Text style={styles.help}>{notDeployed}</Text>
        <Button title="Check again" color={colors.muted} onPress={() => void load()} />
      </View>
    );
  }
  if (!settings) {
    return (
      <View style={[styles.root, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const running = settings.instanceState === 'running';
  const rows: { label: string; value: string; secret?: boolean }[] = [
    { label: 'Host Name', value: settings.host },
    { label: 'Port', value: String(settings.port) },
    { label: 'User', value: settings.user },
    { label: 'Password', value: settings.password, secret: true },
    { label: 'Secure Protocol', value: 'On' },
    { label: 'Passive Mode', value: 'On' },
  ];

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Camera</Text>
        <View style={styles.stateRow}>
          <View style={[styles.dot, { backgroundColor: running ? colors.pick : settings.instanceState === 'stopped' ? colors.reject : colors.muted }]} />
          <Text style={styles.state}>receiver {settings.instanceState}</Text>
        </View>
      </View>

      <Text style={styles.help}>MENU → Network → FTP Transfer → FTP Transfer Func. → Server Setting → Server 1. Tap a value to copy it.</Text>

      <View style={styles.card}>
        {rows.map((r) => (
          <Pressable key={r.label} onPress={() => void copy(r.label, r.value)} style={styles.row}>
            <Text style={styles.label}>{r.label}</Text>
            <Text style={[styles.value, r.secret && styles.mono]} numberOfLines={1}>
              {r.secret && !showPassword ? '••••••••••••' : r.value}
            </Text>
            <Text style={styles.copy}>{copied === r.label ? 'copied' : 'copy'}</Text>
          </Pressable>
        ))}
        <Button title={showPassword ? 'Hide password' : 'Show password'} color={colors.muted} onPress={() => setShowPassword((v) => !v)} />
      </View>

      <Text style={styles.section}>Password</Text>
      <View style={styles.card}>
        <Text style={styles.help}>Letters and digits, 8 to 64 characters. Something short is easier to type on the camera.</Text>
        <TextInput
          value={custom}
          onChangeText={setCustom}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="type a password, or generate one"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
        <View style={styles.actions}>
          <Button title={busy === 'password' ? 'Changing…' : 'Set'} onPress={() => rotate(custom.trim())} disabled={busy !== null || !/^[A-Za-z0-9]{8,64}$/.test(custom.trim())} style={{ flex: 1 }} />
          <Button title="Generate" color={colors.accent} onPress={() => rotate()} disabled={busy !== null} style={{ flex: 1 }} />
        </View>
      </View>

      <Text style={styles.section}>Receiver</Text>
      <View style={styles.card}>
        <Text style={styles.help}>Stop it between shoots; it costs almost nothing while stopped and the camera settings stay valid. Starting takes about a minute.</Text>
        <View style={styles.actions}>
          <Button title={busy === 'start' ? 'Starting…' : 'Start'} color={colors.pick} onPress={() => power('start')} disabled={busy !== null || running} style={{ flex: 1 }} />
          <Button title={busy === 'stop' ? 'Stopping…' : 'Stop'} color={colors.reject} onPress={() => power('stop')} disabled={busy !== null || settings.instanceState !== 'running'} style={{ flex: 1 }} />
          <Button title="Refresh" color={colors.muted} onPress={() => void load()} />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  state: { color: colors.muted },
  help: { color: colors.muted, lineHeight: 20 },
  section: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 8 },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  label: { color: colors.muted, width: 120 },
  value: { color: colors.text, flex: 1, fontWeight: '600' },
  mono: { fontFamily: 'Menlo' },
  copy: { color: colors.accent, fontSize: 12 },
  input: { color: colors.text, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15 },
  actions: { flexDirection: 'row', gap: 10, alignItems: 'center' },
});
