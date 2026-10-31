import { StyleSheet, Text, View } from 'react-native';
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
  if (compact) {
    return (
      <View style={[styles.pill, { borderColor: color }]}>
        <Text style={[styles.pillText, { color }]}>{info.status === 'duplicate' ? LABEL.done : LABEL[info.status]}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.text, { color }]}>{LABEL[info.status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
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
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  text: { fontSize: 12, fontWeight: '700' },
});
