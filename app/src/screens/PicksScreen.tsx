import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import type { Api } from '../lib/api';
import type { Photo } from '../lib/types';
import { colors } from '../lib/theme';
import { sendToLightroom } from '../lib/lightroom';
import { Button } from '../components/Button';

const COLUMNS = 3;

export function PicksScreen({ api }: { api: Api }) {
  const { width } = useWindowDimensions();
  const [picks, setPicks] = useState<Photo[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Photo | null>(null);

  const load = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      try {
        const page = await api.list('pick', 60, reset ? undefined : cursor);
        setPicks((p) => (reset ? page.items : [...p, ...page.items]));
        setCursor(page.cursor);
      } catch (e) {
        Alert.alert('Could not load picks', e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [api, cursor],
  );

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const send = async (photo: Photo) => {
    setBusy(photo.photoId);
    try {
      await sendToLightroom(api, photo.photoId);
    } catch (e) {
      Alert.alert('Could not send to Lightroom', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const unpick = async (photo: Photo) => {
    setSelected(null);
    setPicks((p) => p.filter((x) => x.photoId !== photo.photoId));
    try {
      await api.decide(photo.photoId, 'unreviewed');
    } catch (e) {
      setPicks((p) => [photo, ...p]);
      Alert.alert('Could not update', e instanceof Error ? e.message : String(e));
    }
  };

  const cell = (width - 16 * 2 - 6 * (COLUMNS - 1)) / COLUMNS;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Picks</Text>
        <Text style={styles.count}>{picks.length}{cursor ? '+' : ''}</Text>
      </View>
      <FlatList
        data={picks}
        numColumns={COLUMNS}
        keyExtractor={(p) => p.photoId}
        columnWrapperStyle={{ gap: 6 }}
        contentContainerStyle={{ gap: 6 }}
        onEndReached={() => cursor && !loading && void load(false)}
        onRefresh={() => void load(true)}
        refreshing={loading && picks.length === 0}
        ListEmptyComponent={
          loading ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.empty}>Swipe right on something first.</Text>
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item)} style={{ width: cell, height: cell }}>
            <Image source={{ uri: item.thumbUrl }} contentFit="cover" style={styles.thumb} />
            {busy === item.photoId && (
              <View style={styles.overlay}>
                <ActivityIndicator color={colors.text} />
              </View>
            )}
          </Pressable>
        )}
      />

      {selected && (
        <View style={styles.sheet}>
          <Image source={{ uri: selected.previewUrl }} placeholder={{ uri: selected.thumbUrl }} contentFit="contain" style={styles.sheetImage} />
          <Text style={styles.fileName}>{selected.fileName}</Text>
          <View style={styles.sheetActions}>
            <Button title="Not a pick" color={colors.reject} onPress={() => void unpick(selected)} />
            <Button
              title={busy === selected.photoId ? 'Downloading…' : 'Send to Lightroom'}
              color={colors.pick}
              disabled={busy !== null}
              onPress={() => void send(selected)}
              style={{ flex: 1 }}
            />
            <Button title="Close" color={colors.muted} onPress={() => setSelected(null)} />
          </View>
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
  overlay: { position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', borderRadius: 6 },
  empty: { color: colors.muted, textAlign: 'center', marginTop: 40 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: 0,
    backgroundColor: colors.bg,
    padding: 16,
    gap: 12,
  },
  sheetImage: { flex: 1, borderRadius: 12, backgroundColor: colors.card },
  fileName: { color: colors.text, fontWeight: '600', textAlign: 'center' },
  sheetActions: { flexDirection: 'row', gap: 10, alignItems: 'center' },
});
