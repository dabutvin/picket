import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { LightroomInfo } from '../lib/types';
import { colors } from '../lib/theme';

const LABEL: Record<LightroomInfo['status'], string> = {
  queued: 'Queued',
  uploading: 'Sending…',
  done: 'In Lightroom',
  duplicate: 'Already in Lightroom',
  failed: 'Failed',
};

const COLOR: Record<LightroomInfo['status'], string> = {
  queued: colors.muted,
  uploading: colors.accent,
  done: colors.pick,
  duplicate: colors.pick,
  failed: colors.reject,
};

/** Upload state of a pick. `compact` is the small pill on a grid thumbnail. */
export function LightroomBadge({ info, compact = false }: { info?: LightroomInfo; compact?: boolean }) {
  if (!info) return null;
  const color = COLOR[info.status];
  const busy = info.status === 'uploading';
  if (compact) {
    return (
      <View style={[styles.pill, { borderColor: color }]}>
        {busy && <ActivityIndicator size="small" color={color} style={styles.pillSpinner} />}
        <Text style={[styles.pillText, { color }]}>{info.status === 'duplicate' ? LABEL.done : LABEL[info.status]}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      {busy && <ActivityIndicator size="small" color={color} style={styles.badgeSpinner} />}
      <Text style={[styles.text, { color }]}>{LABEL[info.status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    position: 'absolute',
    left: 5,
    bottom: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  pillText: { fontSize: 10, fontWeight: '700' },
  pillSpinner: { transform: [{ scale: 0.5 }], width: 10, height: 10 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  badgeSpinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
  text: { fontSize: 12, fontWeight: '700' },
});
