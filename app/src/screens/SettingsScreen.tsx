import { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from '../lib/theme';
import { saveSettings, clearSettings, type Settings } from '../lib/settings';
import { createApi } from '../lib/api';
import { Button } from '../components/Button';

interface Props {
  initial: Settings | null;
  onSaved: (s: Settings | null) => void;
}

export function SettingsScreen({ initial, onSaved }: Props) {
  const [apiUrl, setApiUrl] = useState(initial?.apiUrl ?? '');
  const [token, setToken] = useState(initial?.token ?? '');
  const [testing, setTesting] = useState(false);

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

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Settings</Text>
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
      {initial && (
        <Button
          title="Sign out"
          color={colors.reject}
          onPress={() => {
            void clearSettings().then(() => onSaved(null));
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  help: { color: colors.muted, lineHeight: 20 },
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
});
