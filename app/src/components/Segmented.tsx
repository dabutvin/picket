import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../lib/theme';

interface Props<K extends string> {
  options: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  testIDPrefix?: string;
}

/** An iOS-style segmented switch. */
export function Segmented<K extends string>({ options, value, onChange, testIDPrefix }: Props<K>) {
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            style={[styles.seg, on && styles.segOn]}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            testID={testIDPrefix ? `${testIDPrefix}-${o.key}` : undefined}
          >
            <Text style={[styles.label, on && styles.labelOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: 10, padding: 3, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  seg: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 8 },
  segOn: { backgroundColor: colors.raised },
  label: { color: colors.muted, fontWeight: '600', fontSize: 13 },
  labelOn: { color: colors.text },
});
