import { Alert } from 'react-native';
import type { Api } from '../lib/api';
import { colors } from '../lib/theme';
import { Button } from '../components/Button';
import { PhotoGrid } from './PhotoGrid';

const fail = (what: string) => (e: unknown) => Alert.alert(what, e instanceof Error ? e.message : String(e));

/** Everything you swiped left on. Nothing is deleted; change your mind any time. */
export function SkippedScreen({ api }: { api: Api }) {
  return (
    <PhotoGrid
      api={api}
      status="reject"
      title="Skipped"
      emptyText="Nothing skipped yet."
      renderActions={(photo, { remove, close }) => (
        <>
          <Button
            title="Make it a pick"
            color={colors.pick}
            style={{ flex: 1 }}
            onPress={() => {
              remove(photo.photoId);
              api.decide(photo.photoId, 'pick').catch(fail('Could not update'));
            }}
          />
          <Button
            title="Review again"
            color={colors.muted}
            onPress={() => {
              remove(photo.photoId);
              api.decide(photo.photoId, 'unreviewed').catch(fail('Could not update'));
            }}
          />
          <Button title="Close" color={colors.muted} onPress={close} />
        </>
      )}
    />
  );
}
