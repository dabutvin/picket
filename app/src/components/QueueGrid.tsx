import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import type { Photo } from '../lib/types';
import { colors } from '../lib/theme';
import { dayKey, dayLabel } from '../lib/days';
import { Button } from './Button';

const COLUMNS = 3;
const GAP = 6;
const PADDING = 16;
const LABEL_HEIGHT = 32;

type Row = { key: string; kind: 'label'; text: string } | { key: string; kind: 'row'; photos: { photo: Photo; index: number }[] };

interface Props {
  photos: Photo[];
  /** Index of the photo the carousel is showing; highlighted and scrolled into view. */
  index: number;
  /** More photos exist beyond what is loaded. */
  more: boolean;
  loading: boolean;
  onPick: (index: number) => void;
  onEndReached: () => void;
  onClose: () => void;
}

/**
 * The whole review queue as thumbnails grouped by capture day, for jumping the carousel to a
 * different part of the shoot. Tap a photo to go there.
 */
export function QueueGrid({ photos, index, more, loading, onPick, onEndReached, onClose }: Props) {
  const { width } = useWindowDimensions();
  const cell = (width - PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS;
  const rowHeight = cell + GAP;

  // Rows of three, with a day label whenever the capture day changes.
  const { rows, offsets, currentRow } = useMemo(() => {
    const rows: Row[] = [];
    let day = '';
    let row: { photo: Photo; index: number }[] = [];
    let currentRow = 0;
    const flush = () => {
      if (row.length) rows.push({ key: `row-${row[0]!.photo.photoId}`, kind: 'row', photos: row });
      row = [];
    };
    photos.forEach((photo, i) => {
      const d = dayKey(photo.capturedAt);
      if (d !== day) {
        flush();
        day = d;
        rows.push({ key: `day-${d}`, kind: 'label', text: dayLabel(photo.capturedAt) });
      }
      if (i === index) currentRow = rows.length;
      row.push({ photo, index: i });
      if (row.length === COLUMNS) flush();
    });
    flush();
    // Land on the day label when the current photo starts a day, so the label is not hidden above.
    if (rows[currentRow - 1]?.kind === 'label') currentRow -= 1;
    const offsets: number[] = [];
    let y = 0;
    for (const r of rows) {
      offsets.push(y);
      y += r.kind === 'label' ? LABEL_HEIGHT : rowHeight;
    }
    return { rows, offsets, currentRow: Math.min(currentRow, Math.max(0, rows.length - 1)) };
  }, [photos, index, rowHeight]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Jump to</Text>
          <Text style={styles.subtitle}>
            {photos.length}
            {more ? '+' : ''} to review · oldest first
          </Text>
        </View>
        <Button title="Close" color={colors.muted} onPress={onClose} testID="review-grid-close" />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        initialScrollIndex={currentRow > 0 ? currentRow : undefined}
        getItemLayout={(_, i) => ({ length: rows[i]?.kind === 'label' ? LABEL_HEIGHT : rowHeight, offset: offsets[i] ?? 0, index: i })}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.6}
        contentContainerStyle={styles.list}
        ListFooterComponent={loading ? <ActivityIndicator color={colors.accent} style={styles.footer} /> : undefined}
        renderItem={({ item }) =>
          item.kind === 'label' ? (
            <View style={[styles.labelRow, { height: LABEL_HEIGHT }]}>
              <Text style={styles.label}>{item.text}</Text>
            </View>
          ) : (
            <View style={[styles.row, { height: rowHeight }]}>
              {item.photos.map(({ photo, index: i }) => (
                <Pressable key={photo.photoId} onPress={() => onPick(i)} style={{ width: cell, height: cell }} testID={`review-thumb-${photo.photoId}`}>
                  <Image source={{ uri: photo.thumbUrl }} contentFit="cover" style={[styles.thumb, i === index && styles.current]} />
                  <Text style={styles.number}>{i + 1}</Text>
                </Pressable>
              ))}
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.bg, paddingTop: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: PADDING, paddingBottom: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 12, marginTop: 2 },
  list: { paddingHorizontal: PADDING, paddingBottom: 24 },
  labelRow: { justifyContent: 'flex-end', paddingBottom: 6 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  row: { flexDirection: 'row', gap: GAP },
  thumb: { flex: 1, borderRadius: 6, backgroundColor: colors.card },
  current: { borderWidth: 3, borderColor: colors.accent },
  number: {
    position: 'absolute',
    left: 5,
    bottom: 5,
    color: colors.text,
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 5,
    overflow: 'hidden',
  },
  footer: { marginVertical: 16 },
});
