import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';
import { colors } from '../lib/theme';

interface Props {
  title: string;
  onPress: () => void;
  color?: string;
  disabled?: boolean;
  style?: ViewStyle;
  testID?: string;
}

export function Button({ title, onPress, color = colors.accent, disabled, style, testID }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      style={({ pressed }) => [styles.btn, { borderColor: color, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }, style]}
    >
      <Text style={[styles.text, { color }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { paddingVertical: 12, paddingHorizontal: 18, borderRadius: 10, borderWidth: 2, alignItems: 'center' },
  text: { fontWeight: '700', fontSize: 15 },
});
