import { Alert, StyleSheet, View } from 'react-native';
import type { Api } from '../lib/api';
import { colors } from '../lib/theme';
import { noteDecision } from '../lib/recent';
import { Button } from '../components/Button';
import { PhotoGrid } from './PhotoGrid';

const fail = (what: string) => (e: unknown) => Alert.alert(what, e instanceof Error ? e.message : String(e));

/** Everything flicked down in Review. Nothing is deleted; change your mind any time. */
export function SkippedScreen({ api }: { api: Api }) {
  return (
    <PhotoGrid
      api={api}
      status="reject"
      title="Skipped"
      emptyText="Nothing skipped yet. Flick a photo down in Review and it lands here."
      cellBadges={false}
      renderActions={(photo, { remove, close }) => (
        <View style={styles.row}>
          <Button
            title="Make it a pick"
            color={colors.pick}
            style={styles.grow}
            onPress={() => {
              noteDecision(photo, 'pick');
              remove(photo.photoId);
              api.decide(photo.photoId, 'pick').catch(fail('Could not update'));
            }}
          />
          <Button
            title="Review again"
            color={colors.muted}
            onPress={() => {
              noteDecision(photo, 'unreviewed');
              remove(photo.photoId);
              api.decide(photo.photoId, 'unreviewed').catch(fail('Could not update'));
            }}
          />
          <Button title="Close" color={colors.muted} onPress={close} />
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  grow: { flex: 1 },
});
