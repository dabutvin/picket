import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import type { Api } from '../lib/api';
import type { Photo } from '../lib/types';
import { colors } from '../lib/theme';
import { onItsWay } from '../lib/format';
import { noteDecision, notePhoto } from '../lib/recent';
import { Button } from '../components/Button';
import { PhotoGrid, type GridHelpers } from './PhotoGrid';

const fail = (what: string) => (e: unknown) => Alert.alert(what, e instanceof Error ? e.message : String(e));
const SEND_CHUNK = 100; // the API's per-call cap
const SENT_NOTICE_MS = 6000;

const sending = (items: Photo[]) => items.some(onItsWay);

/** What a pick looks like the instant Send is tapped, before the server answers. */
const queuedNow = (p: Photo): Photo => ({
  ...p,
  lightroomStatus: 'queued',
  lightroom: { ...p.lightroom, status: 'queued', updatedAt: new Date().toISOString(), error: undefined },
});

/**
 * Everything flicked up in Review, waiting to go to Lightroom. Nothing uploads until you
 * say so: send everything, or select a few. A photo leaves this tab once Lightroom has it
 * (it moves to Sent) or when you skip it or send it back to Review.
 */
export function PicksScreen({ api }: { api: Api }) {
  const [busy, setBusy] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Photos that were on their way and are no longer on this tab have reached Lightroom.
  const onItemsChange = useCallback((prev: Photo[], next: Photo[]) => {
    const ids = new Set(next.map((p) => p.photoId));
    const done = prev.filter((p) => onItsWay(p) && !ids.has(p.photoId)).length;
    if (!done) return;
    setSentCount((n) => n + done);
    if (sentTimer.current) clearTimeout(sentTimer.current);
    sentTimer.current = setTimeout(() => setSentCount(0), SENT_NOTICE_MS);
  }, []);
  useEffect(() => () => {
    if (sentTimer.current) clearTimeout(sentTimer.current);
  }, []);

  const sendPhotos = useCallback(
    async (photos: Photo[], helpers: GridHelpers) => {
      setBusy(true);
      helpers.replaceMany(photos.map(queuedNow)); // show it before the server says so
      try {
        const ids = photos.map((p) => p.photoId);
        for (let i = 0; i < ids.length; i += SEND_CHUNK) {
          const r = await api.sendMany({ photoIds: ids.slice(i, i + SEND_CHUNK) });
          r.photos.forEach(notePhoto);
          helpers.replaceMany(r.photos);
        }
      } catch (e) {
        fail('Could not send to Lightroom')(e);
        helpers.reload();
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const sendAll = useCallback(
    async (items: Photo[], helpers: GridHelpers) => {
      setBusy(true);
      helpers.replaceMany(items.filter((p) => !onItsWay(p)).map(queuedNow));
      try {
        const r = await api.sendMany({ all: true });
        r.photos.forEach(notePhoto);
        helpers.replaceMany(r.photos);
        helpers.reload(); // picks beyond the loaded page were queued too
      } catch (e) {
        fail('Could not send to Lightroom')(e);
        helpers.reload();
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const skipPhotos = (photos: Photo[], helpers: GridHelpers, then: () => void) => {
    const ids = photos.map((p) => p.photoId);
    Alert.alert(`Skip ${ids.length === 1 ? 'this photo' : `${ids.length} photos`}?`, 'They move to Skipped; nothing is deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Skip',
        style: 'destructive',
        onPress: () => {
          photos.forEach((p) => noteDecision(p, 'reject'));
          helpers.removeMany(ids);
          then();
          Promise.all(ids.map((id) => api.decide(id, 'reject'))).catch(fail('Could not update'));
        },
      },
    ]);
  };

  const progress = (items: Photo[]) => {
    const uploading = items.filter((p) => p.lightroom?.status === 'uploading').length;
    const queued = items.filter((p) => p.lightroom?.status === 'queued').length;
    if (!uploading && !queued && !sentCount) return null;
    return (
      <View style={styles.progress} testID="picks-progress">
        {uploading + queued > 0 ? (
          <>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.progressText}>
              {uploading ? `Sending ${uploading} to Lightroom` : 'Waiting for the uploader'}
              {queued ? ` · ${queued} queued` : ''}
              {sentCount ? ` · ${sentCount} done` : ''}
            </Text>
          </>
        ) : (
          <Text style={[styles.progressText, { color: colors.pick }]}>✓ {sentCount} sent to Lightroom</Text>
        )}
      </View>
    );
  };

  return (
    <PhotoGrid
      api={api}
      status="pick"
      title="Picks"
      emptyText="Flick a photo up in Review and it waits here until you send it to Lightroom."
      subtitle={(items) => {
        const inFlight = items.filter(onItsWay).length;
        const waiting = items.length - inFlight;
        return [`${waiting} waiting`, inFlight ? `${inFlight} sending` : ''].filter(Boolean).join(' · ');
      }}
      pollWhile={sending}
      onItemsChange={onItemsChange}
      daySummary={(items) => {
        const inFlight = items.filter(onItsWay).length;
        const failed = items.filter((p) => p.lightroom?.status === 'failed').length;
        return [inFlight ? `${inFlight} sending` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
      }}
      renderBar={({ items, selected, selecting, endSelecting, helpers }) => {
        if (selecting) {
          const sendable = selected.filter((p) => !onItsWay(p));
          return (
            <>
              {progress(items)}
              <View style={styles.row}>
                <Button title={`Skip ${selected.length || ''}`.trim()} color={colors.reject} disabled={busy || !selected.length} onPress={() => skipPhotos(selected, helpers, endSelecting)} />
                <Button
                  title={busy ? 'Sending…' : sendable.length ? `Send ${sendable.length} to Lightroom` : 'Select photos to send'}
                  color={colors.accent}
                  style={styles.grow}
                  disabled={busy || !sendable.length}
                  onPress={() => void sendPhotos(sendable, helpers).then(endSelecting)}
                />
              </View>
            </>
          );
        }
        const waiting = items.filter((p) => !onItsWay(p)).length;
        if (!items.length && !sentCount) return null;
        return (
          <>
            {progress(items)}
            {items.length > 0 && (
              <>
                <Button
                  title={busy ? 'Sending…' : waiting ? `Send all ${waiting} to Lightroom` : 'Everything is on its way'}
                  color={colors.accent}
                  disabled={busy || !waiting}
                  onPress={() => void sendAll(items, helpers)}
                  testID="picks-send-all"
                />
                <Text style={styles.hint}>Long-press a photo to send or skip just a few.</Text>
              </>
            )}
          </>
        );
      }}
      renderActions={(photo, helpers) => {
        const lr = photo.lightroom?.status;
        const sendTitle = lr === 'failed' ? 'Retry upload' : lr === 'queued' ? 'Send again' : lr === 'uploading' ? 'Uploading…' : 'Send to Lightroom';
        return (
          <>
            <Button
              title={sendTitle}
              color={colors.accent}
              disabled={lr === 'uploading'}
              onPress={() => {
                helpers.replace(queuedNow(photo));
                api.sendOne(photo.photoId).then(
                  (p) => {
                    notePhoto(p);
                    helpers.replace(p);
                  },
                  (e: unknown) => {
                    helpers.replace(photo);
                    fail('Could not send')(e);
                  },
                );
              }}
              testID="picks-send-one"
            />
            <View style={styles.row}>
              <Button title="Skip" color={colors.reject} onPress={() => skipPhotos([photo], helpers, helpers.close)} />
              <Button
                title="Review again"
                color={colors.muted}
                style={styles.grow}
                onPress={() => {
                  noteDecision(photo, 'unreviewed');
                  helpers.remove(photo.photoId);
                  api.decide(photo.photoId, 'unreviewed').catch(fail('Could not update'));
                }}
              />
              <Button title="Close" color={colors.muted} onPress={helpers.close} testID="detail-close" />
            </View>
          </>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  grow: { flex: 1 },
  hint: { color: colors.muted, fontSize: 12, textAlign: 'center' },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  progressText: { color: colors.text, fontSize: 13, fontWeight: '600' },
});
