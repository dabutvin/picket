import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { colors } from '../lib/theme';

/**
 * - `filled`: the one main action on a screen (solid colour, dark text).
 * - `tinted` (default): everything else; a raised neutral surface with the label in the colour.
 *   (A wash of red or green over near-black turns muddy, so the colour stays in the label.)
 *   Grey (`colors.muted`) keeps light text so a secondary button never reads as disabled.
 */
export type ButtonVariant = 'filled' | 'tinted';

interface Props {
  title: string;
  onPress: () => void;
  color?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  style?: ViewStyle;
  testID?: string;
}

export function Button({ title, onPress, color = colors.accent, variant = 'tinted', disabled, style, testID }: Props) {
  const filled = variant === 'filled';
  const grey = color === colors.muted;
  const background = filled ? color : colors.raised;
  const text = filled ? colors.onFill : grey ? colors.text : color;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.btn, { backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }, style]}
    >
      <Text style={[styles.text, { color: text }]} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { paddingVertical: 14, paddingHorizontal: 18, borderRadius: 12, alignItems: 'center' },
  text: { fontWeight: '700', fontSize: 15 },
});
