import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import type { Api } from '../lib/api';
import type { Photo } from '../lib/types';
import { colors } from '../lib/theme';
import { onItsWay } from '../lib/format';
import { Button } from '../components/Button';
import { PhotoGrid, type GridHelpers } from './PhotoGrid';

const fail = (what: string) => (e: unknown) => Alert.alert(what, e instanceof Error ? e.message : String(e));
const SEND_CHUNK = 100; // the API's per-call cap

const sending = (items: Photo[]) => items.some(onItsWay);

/**
 * Everything flicked up in Review, waiting to go to Lightroom. Nothing uploads until you
 * say so: send everything, or select a few. A photo leaves this tab once Lightroom has it
 * (it moves to Sent) or when you skip it or send it back to Review.
 */
export function PicksScreen({ api }: { api: Api }) {
  const [busy, setBusy] = useState(false);

  const sendPhotos = useCallback(
    async (photos: Photo[], helpers: GridHelpers) => {
      setBusy(true);
      try {
        const ids = photos.map((p) => p.photoId);
        for (let i = 0; i < ids.length; i += SEND_CHUNK) {
          const r = await api.sendMany({ photoIds: ids.slice(i, i + SEND_CHUNK) });
          helpers.replaceMany(r.photos);
        }
      } catch (e) {
        fail('Could not send to Lightroom')(e);
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const sendAll = useCallback(
    async (helpers: GridHelpers) => {
      setBusy(true);
      try {
        const r = await api.sendMany({ all: true });
        helpers.replaceMany(r.photos);
        helpers.reload(); // picks beyond the loaded page were queued too
      } catch (e) {
        fail('Could not send to Lightroom')(e);
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
          helpers.removeMany(ids);
          then();
          Promise.all(ids.map((id) => api.decide(id, 'reject'))).catch(fail('Could not update'));
        },
      },
    ]);
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
      daySummary={(items) => {
        const inFlight = items.filter(onItsWay).length;
        const failed = items.filter((p) => p.lightroom?.status === 'failed').length;
        return [inFlight ? `${inFlight} sending` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
      }}
      renderBar={({ items, selected, selecting, endSelecting, helpers }) => {
        if (selecting) {
          const sendable = selected.filter((p) => !onItsWay(p));
          return (
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
          );
        }
        const waiting = items.filter((p) => !onItsWay(p)).length;
        if (!items.length) return null;
        return (
          <>
            <Button
              title={busy ? 'Sending…' : waiting ? `Send all ${waiting} to Lightroom` : 'Everything is on its way'}
              color={colors.accent}
              disabled={busy || !waiting}
              onPress={() => void sendAll(helpers)}
              testID="picks-send-all"
            />
            <Text style={styles.hint}>Long-press a photo to send or skip just a few.</Text>
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
              onPress={() => api.sendOne(photo.photoId).then(helpers.replace, fail('Could not send'))}
              testID="picks-send-one"
            />
            <View style={styles.row}>
              <Button title="Skip" color={colors.reject} onPress={() => skipPhotos([photo], helpers, helpers.close)} />
              <Button
                title="Review again"
                color={colors.muted}
                style={styles.grow}
                onPress={() => {
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
});
