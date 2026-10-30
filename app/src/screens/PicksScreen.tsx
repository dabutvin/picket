import { Alert } from 'react-native';
import type { Api } from '../lib/api';
import { colors } from '../lib/theme';
import { Button } from '../components/Button';
import { PhotoGrid } from './PhotoGrid';

const fail = (what: string) => (e: unknown) => Alert.alert(what, e instanceof Error ? e.message : String(e));

/** Everything you swiped right on. Uploads to Lightroom happen on the server; this shows their state. */
export function PicksScreen({ api }: { api: Api }) {
  return (
    <PhotoGrid
      api={api}
      status="pick"
      title="Picks"
      emptyText="Swipe right on something first."
      renderActions={(photo, { replace, remove, close }) => (
        <>
          <Button
            title="Not a pick"
            color={colors.reject}
            onPress={() => {
              remove(photo.photoId);
              api.decide(photo.photoId, 'unreviewed').catch(fail('Could not update'));
            }}
          />
          {photo.lightroom?.status === 'failed' && (
            <Button
              title="Retry upload"
              color={colors.accent}
              style={{ flex: 1 }}
              onPress={() => {
                api.retryLightroom(photo.photoId).then(replace, fail('Could not retry'));
              }}
            />
          )}
          <Button title="Close" color={colors.muted} onPress={close} style={{ flex: 1 }} />
        </>
      )}
    />
  );
}
