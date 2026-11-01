import { StyleSheet, Text } from 'react-native';
import type { ReactNode } from 'react';
import type { Api } from '../lib/api';
import { colors } from '../lib/theme';
import { Button } from '../components/Button';
import { PhotoGrid } from './PhotoGrid';

/** Picks that Lightroom has. Done from this app's point of view; kept so you can see what went. */
export function SentScreen({ api, title = 'Sent', headerExtra }: { api: Api; title?: string; headerExtra?: ReactNode }) {
  return (
    <PhotoGrid
      api={api}
      status="sent"
      title={title}
      headerExtra={headerExtra}
      emptyText="Nothing has gone to Lightroom yet. Send picks from the Picks tab and they land here once Lightroom has them."
      subtitle={(_items, count) => `${count} in Lightroom`}
      cellBadges={false}
      renderActions={(_photo, { close }) => (
        <>
          <Text style={styles.note}>In the Picket album of your Lightroom catalog. Nothing here changes Lightroom.</Text>
          <Button title="Close" color={colors.muted} onPress={close} />
        </>
      )}
    />
  );
}

const styles = StyleSheet.create({
  note: { color: colors.muted, fontSize: 12, lineHeight: 18 },
});
