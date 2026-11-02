import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import type { Api } from '../lib/api';
import { openSystemSettings, type PushState } from '../lib/push';
import { colors } from '../lib/theme';
import { Button } from '../components/Button';

interface Props {
  api: Api;
  push: PushState | null;
  onEnable: () => void;
  /** Turn this phone's weekly "photos waiting to review" reminder on or off. */
  onReminders: (on: boolean) => void;
}

/**
 * New-photo notifications: whether this phone gets them, and a test push. The server pushes when
 * a batch starts syncing and when it is done; live transfer while shooting is left alone (ADR-010).
 */
export function NotificationsSection({ api, push, onEnable, onReminders }: Props) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);

  const test = () => {
    setTesting(true);
    setResult(null);
    api
      .testNotification()
      .then(
        (r) =>
          setResult(
            !r.configured
              ? { ok: false, text: 'The server has no APNs key yet, so nothing was sent. See docs/OPERATIONS.md → Notifications.' }
              : r.delivered > 0
                ? { ok: true, text: `Sent to ${r.delivered === 1 ? 'this phone' : `${r.delivered} phones`}. It should arrive in a few seconds.` }
                : { ok: false, text: r.attempted ? 'Apple refused the push; open the app again to re-register, then retry.' : 'No phone is registered yet.' },
          ),
        (e: unknown) => setResult({ ok: false, text: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => setTesting(false));
  };

  const status = push?.status;
  return (
    <>
      <Text style={styles.section}>Notifications</Text>
      <View style={styles.card} testID="notifications-card">
        <Text style={styles.cardTitle}>
          {status === undefined
            ? 'Checking…'
            : status === 'on'
              ? 'On for this phone'
              : status === 'denied'
                ? 'Off in iOS Settings'
                : status === 'unsupported'
                  ? 'Available in the iPhone app'
                  : status === 'error'
                    ? 'Could not register this phone'
                    : 'Off'}
        </Text>
        <Text style={styles.help}>
          {'Picket tells you when a batch of photos starts syncing from the camera, and again when it’s done with how many came in. Photos sent while you’re still shooting (taken under 10 minutes before they sync) don’t notify. The app icon shows how many are waiting to review.'}
        </Text>
        {status === 'on' && push?.serverReady === false && (
          <Text style={[styles.help, { color: colors.reject }]}>The server has no APNs key yet, so nothing is sent until it is added and deployed.</Text>
        )}
        {status === 'error' && push?.error && <Text style={[styles.help, { color: colors.reject }]}>{push.error}</Text>}
        {status === 'undetermined' || status === 'error' ? (
          <Button title="Turn on notifications" variant="filled" onPress={onEnable} testID="notifications-enable" />
        ) : status === 'denied' ? (
          <Button title="Open iOS Settings" color={colors.muted} onPress={openSystemSettings} />
        ) : status === 'on' ? (
          <Button title={testing ? 'Sending…' : 'Send a test notification'} color={colors.muted} onPress={test} disabled={testing} testID="notifications-test" />
        ) : null}
        {result && <Text style={[styles.help, { color: result.ok ? colors.pick : colors.reject }]}>{result.text}</Text>}
        {status === 'on' && (
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Weekly review reminder</Text>
              <Text style={styles.help}>About once a week, on a different day each time, if photos are waiting in Review.</Text>
            </View>
            <Switch
              value={push?.reminders !== false}
              onValueChange={onReminders}
              trackColor={{ true: colors.accent, false: colors.border }}
              testID="notifications-reminders"
              accessibilityLabel="Weekly review reminder"
            />
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  section: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 16 },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.border },
  cardTitle: { color: colors.text, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.text, fontWeight: '600' },
  help: { color: colors.muted, lineHeight: 20 },
});
