import { StyleSheet, Text, View } from 'react-native';
import type { LightroomInfo } from '../lib/types';
import { colors } from '../lib/theme';

const LABEL: Record<LightroomInfo['status'], string> = {
  queued: 'Queued',
  uploading: 'Uploading…',
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

export function LightroomBadge({ info, compact = false }: { info?: LightroomInfo; compact?: boolean }) {
  if (!info) return null;
  const color = COLOR[info.status];
  if (compact) return <View style={[styles.dot, { backgroundColor: color }]} />;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.text, { color }]}>{LABEL[info.status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { position: 'absolute', right: 6, bottom: 6, width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: '#000' },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  text: { fontSize: 12, fontWeight: '700' },
});
