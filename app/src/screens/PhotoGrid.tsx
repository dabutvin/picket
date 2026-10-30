import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import type { Api } from '../lib/api';
import type { Photo, PhotoStatus } from '../lib/types';
import { colors } from '../lib/theme';
import { LightroomBadge } from '../components/LightroomBadge';

const COLUMNS = 3;

interface Props {
  api: Api;
  status: PhotoStatus;
  title: string;
  emptyText: string;
  /** Rendered under the enlarged photo; receives helpers to mutate the list. */
  renderActions: (photo: Photo, helpers: { replace: (p: Photo) => void; remove: (id: string) => void; close: () => void }) => React.ReactNode;
}

/** Shared grid + detail sheet for the Picks and Skipped screens. */
export function PhotoGrid({ api, status, title, emptyText, renderActions }: Props) {
  const { width } = useWindowDimensions();
  const [items, setItems] = useState<Photo[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Photo | null>(null);

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      try {
        const page = await api.list(status, 60, reset ? undefined : cursor);
        setItems((p) => (reset ? page.items : [...p, ...page.items.filter((n) => !p.some((x) => x.photoId === n.photoId))]));
        setCursor(page.cursor);
      } catch (e) {
        Alert.alert(`Could not load ${title.toLowerCase()}`, e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [api, cursor, status, title],
  );

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, status]);

  const helpers = {
    replace: (p: Photo) => {
      setItems((list) => list.map((x) => (x.photoId === p.photoId ? p : x)));
      setSelected((s) => (s?.photoId === p.photoId ? p : s));
    },
    remove: (id: string) => {
      setItems((list) => list.filter((x) => x.photoId !== id));
      setSelected((s) => (s?.photoId === id ? null : s));
    },
    close: () => setSelected(null),
  };

  const cell = (width - 16 * 2 - 6 * (COLUMNS - 1)) / COLUMNS;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.count}>
          {items.length}
          {cursor ? '+' : ''}
        </Text>
      </View>
      <FlatList
        data={items}
        numColumns={COLUMNS}
        keyExtractor={(p) => p.photoId}
        columnWrapperStyle={{ gap: 6 }}
        contentContainerStyle={{ gap: 6 }}
        onEndReached={() => cursor && !loading && void load(false)}
        onRefresh={() => void load(true)}
        refreshing={loading && items.length === 0}
        ListEmptyComponent={loading ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.empty}>{emptyText}</Text>}
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item)} style={{ width: cell, height: cell }}>
            <Image source={{ uri: item.thumbUrl }} contentFit="cover" style={styles.thumb} />
            <LightroomBadge info={item.lightroom} compact />
          </Pressable>
        )}
      />

      {selected && (
        <View style={styles.sheet}>
          <Image source={{ uri: selected.previewUrl }} placeholder={{ uri: selected.thumbUrl }} contentFit="contain" style={styles.sheetImage} />
          <View style={styles.metaRow}>
            <Text style={styles.fileName}>{selected.fileName}</Text>
            <LightroomBadge info={selected.lightroom} />
          </View>
          {selected.lightroom?.error && <Text style={styles.error}>{selected.lightroom.error}</Text>}
          <View style={styles.sheetActions}>{renderActions(selected, helpers)}</View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  count: { color: colors.muted },
  thumb: { flex: 1, borderRadius: 6, backgroundColor: colors.card },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 40 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, backgroundColor: colors.bg, padding: 16, gap: 12 },
  sheetImage: { flex: 1, borderRadius: 12, backgroundColor: colors.card },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fileName: { color: colors.text, fontWeight: '600' },
  error: { color: colors.reject, fontSize: 12 },
  sheetActions: { flexDirection: 'row', gap: 10, alignItems: 'center' },
});
