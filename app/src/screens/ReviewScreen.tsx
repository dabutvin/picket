import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { Api } from '../lib/api';
import type { Photo } from '../lib/types';
import { colors } from '../lib/theme';
import { Button } from '../components/Button';
import { SwipeCard, type Decision } from '../components/SwipeCard';

const PAGE = 30;
const REFILL_AT = 8;
const PREFETCH = 3;

export function ReviewScreen({ api }: { api: Api }) {
  const [queue, setQueue] = useState<Photo[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ photo: Photo; decision: Decision } | null>(null);
  const [decided, setDecided] = useState(0);
  const command = useRef<((d: Decision) => void) | null>(null);
  const loadingRef = useRef(false);

  const loadMore = useCallback(
    async (reset = false) => {
      if (loadingRef.current || (exhausted && !reset)) return;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const page = await api.list('unreviewed', PAGE, reset ? undefined : cursor);
        setQueue((q) => {
          const seen = new Set(reset ? [] : q.map((p) => p.photoId));
          return [...(reset ? [] : q), ...page.items.filter((p) => !seen.has(p.photoId))];
        });
        setCursor(page.cursor);
        setExhausted(!page.cursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [api, cursor, exhausted],
  );

  useEffect(() => {
    void loadMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    if (queue.length < REFILL_AT && !exhausted) void loadMore();
    const urls = queue.slice(1, 1 + PREFETCH).map((p) => p.previewUrl);
    if (urls.length) void Image.prefetch(urls, 'memory-disk');
  }, [queue, exhausted, loadMore]);

  const onDecision = useCallback(
    (photo: Photo, decision: Decision) => {
      setQueue((q) => q.filter((p) => p.photoId !== photo.photoId));
      setLast({ photo, decision });
      setDecided((n) => n + 1);
      api.decide(photo.photoId, decision).catch((e: unknown) => {
        // Put it back at the front so nothing is silently lost.
        setQueue((q) => [photo, ...q]);
        setDecided((n) => n - 1);
        Alert.alert('Could not save decision', e instanceof Error ? e.message : String(e));
      });
    },
    [api],
  );

  const undo = useCallback(() => {
    if (!last) return;
    const { photo } = last;
    setLast(null);
    setQueue((q) => [{ ...photo, status: 'unreviewed' }, ...q]);
    setDecided((n) => Math.max(0, n - 1));
    api.decide(photo.photoId, 'unreviewed').catch((e: unknown) => {
      Alert.alert('Could not undo', e instanceof Error ? e.message : String(e));
    });
  }, [api, last]);

  const top = queue[0];
  const next = queue[1];

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Review</Text>
        <Text style={styles.count}>
          {queue.length}
          {exhausted ? '' : '+'} left · {decided} done
        </Text>
      </View>

      <View style={styles.deck}>
        {next && (
          <View style={[styles.under]} pointerEvents="none">
            <Image source={{ uri: next.previewUrl }} placeholder={{ uri: next.thumbUrl }} contentFit="contain" style={{ flex: 1 }} />
          </View>
        )}
        {top ? (
          <SwipeCard key={top.photoId} photo={top} onDecision={onDecision} commandRef={command} />
        ) : loading ? (
          <ActivityIndicator color={colors.accent} />
        ) : error ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Couldn't load photos</Text>
            <Text style={styles.emptyText}>{error}</Text>
            <Button title="Retry" onPress={() => void loadMore(true)} />
          </View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptyText}>New shots show up here as the camera uploads them.</Text>
            <Button title="Refresh" onPress={() => void loadMore(true)} />
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <Button title="Skip" color={colors.reject} onPress={() => command.current?.('reject')} disabled={!top} style={styles.action} />
        <Button title="Undo" color={colors.muted} onPress={undo} disabled={!last} />
        <Button title="Pick" color={colors.pick} onPress={() => command.current?.('pick')} disabled={!top} style={styles.action} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  count: { color: colors.muted },
  deck: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  under: {
    position: 'absolute',
    inset: 0,
    transform: [{ scale: 0.96 }],
    opacity: 0.6,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  actions: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  action: { flex: 1 },
  empty: { alignItems: 'center', gap: 12, padding: 24 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  emptyText: { color: colors.muted, textAlign: 'center' },
});
