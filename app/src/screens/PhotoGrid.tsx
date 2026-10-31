import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import type { Api } from '../lib/api';
import type { Photo, PhotoStatus } from '../lib/types';
import { colors } from '../lib/theme';
import { captureTime, exifLine, megabytes } from '../lib/format';
import { chunk, groupByDay } from '../lib/days';
import { EXPORT_NOTE, saveToPhotos, sharePreview } from '../lib/export';
import { LightroomBadge } from '../components/LightroomBadge';
import { Button } from '../components/Button';

const COLUMNS = 3;
const GAP = 6;
const PAGE = 60;
const POLL_MS = 5000;

/** Collapsed days per tab, kept across tab switches (each tab unmounts when another is shown). */
const collapsedByStatus = new Map<PhotoStatus, Set<string>>();

export interface GridHelpers {
  replace: (p: Photo) => void;
  replaceMany: (ps: Photo[]) => void;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  close: () => void;
  reload: () => void;
}

export interface BarContext {
  items: Photo[];
  selected: Photo[];
  selecting: boolean;
  endSelecting: () => void;
  helpers: GridHelpers;
}

interface Props {
  api: Api;
  status: PhotoStatus;
  title: string;
  emptyText: string;
  /** Rendered under the enlarged photo; receives helpers to mutate the list. */
  renderActions: (photo: Photo, helpers: GridHelpers) => ReactNode;
  /** A bar under the grid. When given, "Select" (or a long press) turns thumbnails into a multi-select. */
  renderBar?: (ctx: BarContext) => ReactNode;
  /** Reload every few seconds while this holds (uploads in progress). */
  pollWhile?: (items: Photo[]) => boolean;
  /** Under the title, instead of the plain count. */
  subtitle?: (items: Photo[]) => string;
  /** Next to a day's count in its header, e.g. "2 sending". */
  daySummary?: (items: Photo[]) => string;
  /** Show each thumbnail's Lightroom state. Off for the Sent tab, where it says the same thing on every cell. */
  cellBadges?: boolean;
}

type Row =
  | { key: string; kind: 'day'; day: string; label: string; photos: Photo[]; collapsed: boolean }
  | { key: string; kind: 'row'; photos: Photo[] };

/**
 * Shared grid + detail view for the Picks, Sent and Skipped screens. Photos are grouped under
 * capture-day headers (oldest first, as the API lists them); tap a header to collapse the day,
 * and in selection mode its circle selects or clears the whole day.
 */
export function PhotoGrid({ api, status, title, emptyText, renderActions, renderBar, pollWhile, subtitle, daySummary, cellBadges = true }: Props) {
  const { width } = useWindowDimensions();
  const [items, setItems] = useState<Photo[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Photo | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => collapsedByStatus.get(status) ?? new Set());
  const [exporting, setExporting] = useState<'save' | 'share' | 'saved' | null>(null);

  const load = useCallback(
    async (mode: 'reset' | 'more' | 'refresh' | 'poll') => {
      if (mode === 'refresh') setRefreshing(true);
      else if (mode !== 'poll') setLoading(true);
      try {
        const page = await api.list(status, PAGE, mode === 'more' ? cursor : undefined);
        setItems((p) => (mode === 'more' ? [...p, ...page.items.filter((n) => !p.some((x) => x.photoId === n.photoId))] : page.items));
        setCursor(page.cursor);
      } catch (e) {
        if (mode !== 'poll') Alert.alert(`Could not load ${title.toLowerCase()}`, e instanceof Error ? e.message : String(e));
      } finally {
        setRefreshing(false);
        setLoading(false);
      }
    },
    [api, cursor, status, title],
  );

  useEffect(() => {
    void load('reset');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, status]);

  // While something is on its way to Lightroom, keep the states fresh (a sent photo leaves this tab).
  useEffect(() => {
    if (!pollWhile?.(items)) return;
    const t = setTimeout(() => void load('poll'), POLL_MS);
    return () => clearTimeout(t);
  }, [items, pollWhile, load]);

  // Drop selections that left the list (sent, skipped, un-picked).
  useEffect(() => {
    setPicked((s) => {
      const ids = new Set(items.map((p) => p.photoId));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [items]);

  const helpers: GridHelpers = useMemo(
    () => ({
      replace: (p) => {
        setItems((list) => list.map((x) => (x.photoId === p.photoId ? p : x)));
        setSelected((s) => (s?.photoId === p.photoId ? p : s));
      },
      replaceMany: (ps) => {
        const by = new Map(ps.map((p) => [p.photoId, p]));
        setItems((list) => list.map((x) => by.get(x.photoId) ?? x));
        setSelected((s) => (s && by.get(s.photoId)) ?? s);
      },
      remove: (id) => {
        setItems((list) => list.filter((x) => x.photoId !== id));
        setSelected((s) => (s?.photoId === id ? null : s));
      },
      removeMany: (ids) => {
        const gone = new Set(ids);
        setItems((list) => list.filter((x) => !gone.has(x.photoId)));
        setSelected((s) => (s && gone.has(s.photoId) ? null : s));
      },
      close: () => {
        setSelected(null);
        setExporting(null);
      },
      reload: () => void load('poll'),
    }),
    [load],
  );

  const endSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleDay = (photos: Photo[]) =>
    setPicked((s) => {
      const next = new Set(s);
      const all = photos.every((p) => next.has(p.photoId));
      for (const p of photos) if (all) next.delete(p.photoId);
      else next.add(p.photoId);
      return next;
    });
  const toggleCollapsed = (day: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      collapsedByStatus.set(status, next);
      return next;
    });

  const cell = (width - 16 * 2 - GAP * (COLUMNS - 1)) / COLUMNS;
  const pickedItems = items.filter((p) => picked.has(p.photoId));

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groupByDay(items)) {
      const isCollapsed = collapsed.has(g.key);
      out.push({ key: `day-${g.key}`, kind: 'day', day: g.key, label: g.label, photos: g.items, collapsed: isCollapsed });
      if (!isCollapsed) for (const photos of chunk(g.items, COLUMNS)) out.push({ key: `row-${photos[0]!.photoId}`, kind: 'row', photos });
    }
    return out;
  }, [items, collapsed]);

  const renderThumb = (item: Photo) => {
    const isPicked = picked.has(item.photoId);
    return (
      <Pressable
        key={item.photoId}
        onPress={() => (selecting ? toggle(item.photoId) : setSelected(item))}
        onLongPress={
          renderBar
            ? () => {
                setSelecting(true);
                toggle(item.photoId);
              }
            : undefined
        }
        style={{ width: cell, height: cell }}
        testID={`thumb-${item.photoId}`}
      >
        <Image source={{ uri: item.thumbUrl }} contentFit="cover" style={[styles.thumb, isPicked && styles.thumbPicked]} />
        {cellBadges && <LightroomBadge info={item.lightroom} compact />}
        {selecting && <View style={[styles.check, isPicked && styles.checkOn]}>{isPicked && <Text style={styles.checkMark}>✓</Text>}</View>}
      </Pressable>
    );
  };

  const renderDay = (row: Extract<Row, { kind: 'day' }>) => {
    const allPicked = row.photos.every((p) => picked.has(p.photoId));
    const summary = daySummary?.(row.photos);
    return (
      <View style={styles.day}>
        <Pressable onPress={() => toggleCollapsed(row.day)} hitSlop={6} style={styles.dayToggle} testID={`day-${row.day}`}>
          <Text style={styles.chevron}>{row.collapsed ? '▸' : '▾'}</Text>
          <Text style={styles.dayLabel}>{row.label}</Text>
          <Text style={styles.dayCount}>
            {row.photos.length}
            {summary ? ` · ${summary}` : ''}
          </Text>
        </Pressable>
        {selecting && (
          <Pressable onPress={() => toggleDay(row.photos)} hitSlop={8} testID={`day-select-${row.day}`}>
            <View style={[styles.check, styles.dayCheck, allPicked && styles.checkOn]}>{allPicked && <Text style={styles.checkMark}>✓</Text>}</View>
          </Pressable>
        )}
      </View>
    );
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle ? subtitle(items) : `${items.length}${cursor ? '+' : ''}`}</Text>
        </View>
        {renderBar && items.length > 0 && (
          <Pressable onPress={() => (selecting ? endSelecting() : setSelecting(true))} hitSlop={8} testID="grid-select">
            <Text style={styles.headerAction}>{selecting ? 'Done' : 'Select'}</Text>
          </Pressable>
        )}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={styles.list}
        onEndReached={() => cursor && !loading && void load('more')}
        onEndReachedThreshold={0.6}
        onRefresh={() => void load('refresh')}
        refreshing={refreshing}
        extraData={[picked, selecting]}
        ListEmptyComponent={loading ? <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} /> : <Text style={styles.empty}>{emptyText}</Text>}
        renderItem={({ item }) => (item.kind === 'day' ? renderDay(item) : <View style={styles.row}>{item.photos.map(renderThumb)}</View>)}
      />
      {renderBar && <View style={styles.bar}>{renderBar({ items, selected: pickedItems, selecting, endSelecting, helpers })}</View>}

      {selected && (
        <View style={styles.sheet}>
          <Image source={{ uri: selected.previewUrl }} placeholder={{ uri: selected.thumbUrl }} contentFit="contain" style={styles.sheetImage} />
          <View style={styles.metaRow}>
            <View style={styles.metaText}>
              <Text style={styles.fileName}>{selected.fileName}</Text>
              <Text style={styles.meta}>{[captureTime(selected.capturedAt), megabytes(selected.bytes)].filter(Boolean).join(' · ')}</Text>
              {!!exifLine(selected) && <Text style={styles.meta}>{exifLine(selected)}</Text>}
            </View>
            <LightroomBadge info={selected.lightroom} />
          </View>
          {selected.lightroom?.error && <Text style={styles.error}>{selected.lightroom.error}</Text>}
          <View style={styles.exportRow}>
            <Button
              title={exporting === 'save' ? 'Saving…' : exporting === 'saved' ? 'Saved to Photos ✓' : 'Save to Photos'}
              color={colors.muted}
              style={styles.grow}
              disabled={exporting === 'save' || exporting === 'share'}
              testID="detail-save"
              onPress={() => {
                setExporting('save');
                saveToPhotos(selected).then(
                  (outcome) => {
                    if (outcome === 'denied') {
                      setExporting(null);
                      Alert.alert('No access to Photos', 'Allow Picket to add photos in Settings → Picket → Photos.');
                      return;
                    }
                    setExporting('saved');
                    setTimeout(() => setExporting(null), 2000);
                  },
                  (e: unknown) => {
                    setExporting(null);
                    Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
                  },
                );
              }}
            />
            <Button
              title={exporting === 'share' ? 'Preparing…' : 'Share…'}
              color={colors.muted}
              style={styles.grow}
              disabled={exporting === 'save' || exporting === 'share'}
              testID="detail-share"
              onPress={() => {
                setExporting('share');
                sharePreview(selected)
                  .then((ok) => {
                    if (!ok) Alert.alert('Sharing is not available on this device');
                  })
                  .catch((e: unknown) => Alert.alert('Could not share', e instanceof Error ? e.message : String(e)))
                  .finally(() => setExporting(null));
              }}
            />
          </View>
          <Text style={styles.exportNote}>{EXPORT_NOTE}</Text>
          <View style={styles.sheetActions}>{renderActions(selected, helpers)}</View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  headerText: { flex: 1 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 12, marginTop: 2 },
  headerAction: { color: colors.accent, fontWeight: '600', paddingBottom: 4 },
  list: { flexGrow: 1, paddingBottom: 8 },
  day: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, paddingBottom: 8 },
  dayToggle: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flex: 1 },
  chevron: { color: colors.muted, fontSize: 12, width: 12 },
  dayLabel: { color: colors.text, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  dayCount: { color: colors.muted, fontSize: 12 },
  dayCheck: { position: 'relative', top: 0, right: 0 },
  row: { flexDirection: 'row', gap: GAP, marginBottom: GAP },
  thumb: { flex: 1, borderRadius: 6, backgroundColor: colors.card },
  thumbPicked: { opacity: 0.6, borderWidth: 3, borderColor: colors.accent },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#fff',
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkMark: { color: '#fff', fontSize: 13, fontWeight: '800', lineHeight: 15 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 40, paddingHorizontal: 24, lineHeight: 20 },
  bar: { gap: 10 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, backgroundColor: colors.bg, padding: 16, gap: 12 },
  sheetImage: { flex: 1, borderRadius: 12, backgroundColor: colors.card },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  metaText: { flex: 1, gap: 2 },
  fileName: { color: colors.text, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 12 },
  error: { color: colors.reject, fontSize: 12 },
  exportRow: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },
  exportNote: { color: colors.muted, fontSize: 11, lineHeight: 15 },
  sheetActions: { gap: 10 },
});
