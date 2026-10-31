import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { LinearTransition, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

interface Props<T> {
  items: T[];
  keyOf: (item: T) => string;
  /** Page in view. `items.length` is the extra page after the last item (end of the queue). */
  index: number;
  onIndexChange: (index: number) => void;
  renderItem: (item: T, active: boolean) => ReactNode;
  renderEnd: () => ReactNode;
}

const SNAP_FRACTION = 0.25; // of page width
const FLING_VELOCITY = 500;
const NEIGHBOURS = 1;

/**
 * A horizontal pager over the review queue: left and right look ahead and go back.
 * Pages sit at absolute offsets by index and the viewport scrolls over them, so removing
 * the page in view slides its neighbour into place (a layout transition) instead of
 * jumping. Only the page in view and its neighbours are mounted.
 */
export function Carousel<T>({ items, keyOf, index, onIndexChange, renderItem, renderEnd }: Props<T>) {
  const { width } = useWindowDimensions();
  const offset = useSharedValue(index * width);
  const start = useSharedValue(0);
  const lastIndex = items.length; // the end page

  // Programmatic moves (undo, reset, a jump from the grid, a rotation) and the rest position
  // after a gesture. Only neighbours are mounted, so anything further than a page lands at once.
  useEffect(() => {
    const target = index * width;
    const delta = Math.abs(offset.value - target);
    if (delta <= 1) return;
    offset.value = delta > width * 1.5 ? target : withTiming(target, { duration: 220 });
  }, [index, width, offset]);

  const pan = Gesture.Pan()
    .activeOffsetX([-14, 14])
    .failOffsetY([-18, 18])
    .onStart(() => {
      start.value = offset.value;
    })
    .onUpdate((e) => {
      const max = lastIndex * width;
      let next = start.value - e.translationX;
      if (next < 0) next /= 3; // rubber band past the ends
      else if (next > max) next = max + (next - max) / 3;
      offset.value = next;
    })
    .onEnd((e) => {
      const from = Math.round(start.value / width);
      let target = from;
      if (e.translationX < -width * SNAP_FRACTION || e.velocityX < -FLING_VELOCITY) target = from + 1;
      else if (e.translationX > width * SNAP_FRACTION || e.velocityX > FLING_VELOCITY) target = from - 1;
      target = Math.max(0, Math.min(lastIndex, target));
      offset.value = withSpring(target * width, { damping: 22, stiffness: 200, overshootClamping: true }, (finished) => {
        if (finished) scheduleOnRN(onIndexChange, target);
      });
    });

  const track = useAnimatedStyle(() => ({ transform: [{ translateX: -offset.value }] }));

  const pages: { key: string; i: number; node: ReactNode }[] = [];
  for (let i = Math.max(0, index - NEIGHBOURS); i <= Math.min(lastIndex, index + NEIGHBOURS); i++) {
    const item = items[i];
    pages.push(
      item === undefined
        ? { key: '__end', i, node: renderEnd() }
        : { key: keyOf(item), i, node: renderItem(item, i === index) },
    );
  }

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.viewport}>
        <Animated.View style={[StyleSheet.absoluteFill, track]}>
          {pages.map((p) => (
            <Animated.View key={p.key} layout={LinearTransition.duration(200)} style={[styles.page, { left: p.i * width, width }]}>
              {p.node}
            </Animated.View>
          ))}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  viewport: { flex: 1, overflow: 'hidden' },
  page: { position: 'absolute', top: 0, bottom: 0, paddingHorizontal: 16 },
});
