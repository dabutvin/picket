import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import type { Api } from '../lib/api';
import type { Photo, Stats } from '../lib/types';
import { colors } from '../lib/theme';
import { noteDecision, withRecent } from '../lib/recent';
import { Button } from '../components/Button';
import { Carousel } from '../components/Carousel';
import { ReviewCard, type CardDecision } from '../components/ReviewCard';
import { QueueGrid } from '../components/QueueGrid';

const PAGE = 30;
const REFILL_AT = 8;
const PREFETCH = 3;

/**
 * First triage. A carousel over `unreviewed` photos, oldest first: swipe left and right to
 * look ahead and go back, flick a photo up to make it a pick, down to skip it. Picks wait on
 * the Picks tab until you send them to Lightroom.
 */
export function ReviewScreen({ api }: { api: Api }) {
  const [queue, setQueue] = useState<Photo[]>([]);
  const [index, setIndex] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>();
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ photo: Photo; decision: CardDecision; index: number } | null>(null);
  const [decided, setDecided] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [grid, setGrid] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const command = useRef<((d: CardDecision) => void) | null>(null);
  const loadingRef = useRef(false);
  // The decision callbacks read the queue through a ref so their identity stays stable
  // (the active card registers them once per photo).
  const queueRef = useRef(queue);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

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
          const merged = [...(reset ? [] : q), ...page.items.filter((p) => !seen.has(p.photoId))];
          return reset ? withRecent('unreviewed', merged) : merged;
        });
        if (reset) setIndex(0);
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

  // Lifetime counts, refreshed every 10 decisions and on load.
  useEffect(() => {
    if (decided % 10 !== 0) return;
    api.stats().then(setStats, () => undefined);
  }, [api, decided]);

  // Keep a few pages ahead of the one in view loaded and their previews warm.
  useEffect(() => {
    if (queue.length - index < REFILL_AT && !exhausted) void loadMore();
    const urls = [...queue.slice(index + 1, index + 1 + PREFETCH), ...queue.slice(Math.max(0, index - 1), index)].map((p) => p.previewUrl);
    if (urls.length) void Image.prefetch(urls, 'memory-disk');
  }, [queue, index, exhausted, loadMore]);

  const onDecision = useCallback(
    (photo: Photo, decision: CardDecision) => {
      const at = queueRef.current.findIndex((p) => p.photoId === photo.photoId);
      if (at < 0) return;
      setLast({ photo, decision, index: at });
      noteDecision(photo, decision);
      setQueue((q) => q.filter((p) => p.photoId !== photo.photoId));
      setDecided((n) => n + 1);
      api.decide(photo.photoId, decision).catch((e: unknown) => {
        // Put it back where it was so nothing is silently lost.
        noteDecision(photo, 'unreviewed');
        setQueue((q) => (q.some((p) => p.photoId === photo.photoId) ? q : [photo, ...q]));
        setLast(null);
        setDecided((n) => n - 1);
        Alert.alert('Could not save decision', e instanceof Error ? e.message : String(e));
      });
    },
    [api],
  );

  const undo = useCallback(() => {
    if (!last) return;
    const { photo, index: at } = last;
    setLast(null);
    noteDecision(photo, 'unreviewed');
    const next = queueRef.current.filter((p) => p.photoId !== photo.photoId);
    const slot = Math.min(at, next.length);
    next.splice(slot, 0, { ...photo, status: 'unreviewed' });
    setQueue(next);
    setIndex(slot);
    setDecided((n) => Math.max(0, n - 1));
    api.decide(photo.photoId, 'unreviewed').catch((e: unknown) => {
      Alert.alert('Could not undo', e instanceof Error ? e.message : String(e));
    });
  }, [api, last]);

  const current = queue[index];
  const position = queue.length ? `${Math.min(index + 1, queue.length)} of ${queue.length}${exhausted ? '' : '+'}` : '';

  const renderEnd = () => (
    <View style={styles.end}>
      {loading ? (
        <ActivityIndicator color={colors.accent} />
      ) : error ? (
        <>
          <Text style={styles.endTitle}>{"Couldn't load photos"}</Text>
          <Text style={styles.endText}>{error}</Text>
          <Button title="Retry" onPress={() => void loadMore(true)} />
        </>
      ) : (
        <>
          <Text style={styles.endTitle}>{queue.length ? "That's everything for now" : 'All caught up'}</Text>
          <Text style={styles.endText}>
            {queue.length ? 'Swipe back to revisit a shot, or refresh for anything new.' : 'New shots show up here as the camera uploads them.'}
          </Text>
          <Button title="Refresh" onPress={() => void loadMore(true)} />
        </>
      )}
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Review</Text>
          <Text style={styles.subtitle}>
            {decided} this session
            {stats ? ` · ${stats.photos.pick ?? 0} to send · ${stats.photos.sent ?? 0} in Lightroom` : ''}
          </Text>
        </View>
        <Pressable onPress={() => setGrid(true)} disabled={!queue.length} hitSlop={8} style={styles.jump} testID="review-grid">
          <Text style={styles.position}>{position}</Text>
          {queue.length > 0 && <Text style={styles.jumpLabel}>▦ Jump to</Text>}
        </Pressable>
      </View>

      <Carousel
        items={queue}
        keyOf={(p) => p.photoId}
        index={index}
        onIndexChange={setIndex}
        renderItem={(photo, active) => (
          <ReviewCard photo={photo} active={active} onDecision={onDecision} commandRef={command} onZoomChange={active ? setZoomed : undefined} />
        )}
        renderEnd={renderEnd}
        enabled={!zoomed}
      />

      {decided === 0 && queue.length > 0 && <Text style={styles.hint}>Flick up to pick, down to skip. Swipe sideways to look around. Pinch or double-tap to zoom.</Text>}

      <View style={styles.actions}>
        <Button title="↓ Skip" color={colors.reject} onPress={() => command.current?.('reject')} disabled={!current} style={styles.action} />
        <Button title="Undo" color={colors.muted} onPress={undo} disabled={!last} />
        <Button title="↑ Pick" color={colors.pick} onPress={() => command.current?.('pick')} disabled={!current} style={styles.action} />
      </View>

      {grid && (
        <QueueGrid
          photos={queue}
          index={index}
          more={!exhausted}
          loading={loading}
          onPick={(i) => {
            setIndex(i);
            setGrid(false);
          }}
          onEndReached={() => void loadMore()}
          onClose={() => setGrid(false)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingVertical: 12, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 16 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 12, marginTop: 2 },
  jump: { alignItems: 'flex-end', paddingBottom: 3 },
  position: { color: colors.muted, fontVariant: ['tabular-nums'] },
  jumpLabel: { color: colors.accent, fontSize: 12, fontWeight: '600', marginTop: 2 },
  hint: { color: colors.muted, fontSize: 12, textAlign: 'center', paddingHorizontal: 16 },
  actions: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingHorizontal: 16 },
  action: { flex: 1 },
  end: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 24 },
  endTitle: { color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  endText: { color: colors.muted, textAlign: 'center' },
});
