import { useEffect, useState } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Image } from 'expo-image';

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const ZOOMED_AT = 1.05;
/** Pinching in from the fitted photo shrinks it down to this, as a hint of what letting go does. */
const PINCH_OUT_FLOOR = 0.6;
/** Let go below this scale (having started at fit) and onPinchOut fires. */
const PINCH_OUT_AT = 0.82;

interface Props {
  uri: string;
  /** Stable disk-cache key (the URL is re-signed on every list call). */
  cacheKey?: string;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
  /** Fires when the image crosses in or out of zoom, so the parents can hand over or take back their pans. */
  onZoomChange?: (zoomed: boolean) => void;
  /** Pinching in from the fitted photo and letting go: "zoom out" past the photo (Review opens its grid). */
  onPinchOut?: () => void;
  testID?: string;
}

/**
 * A preview you can pinch, pan while zoomed, and double-tap to zoom in and out. While not
 * zoomed the single-finger pan is disabled, so the card's flick and the carousel's browse
 * gestures around it keep working; pinch is two fingers and never collides with them.
 */
export function ZoomableImage({ uri, cacheKey, placeholder, style, onZoomChange, onPinchOut, testID }: Props) {
  const [zoomed, setZoomed] = useState(false);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const originX = useSharedValue(0); // image point under the fingers at pinch start, unscaled, from the centre
  const originY = useSharedValue(0);
  const pinching = useSharedValue(false);
  const fromFit = useSharedValue(false); // this pinch started with the photo at fit
  const canPinchOut = !!onPinchOut;
  const pinchedOut = () => onPinchOut?.();

  const clamp = (v: number, lo: number, hi: number) => {
    'worklet';
    return Math.min(hi, Math.max(lo, v));
  };
  /** Furthest the image may travel at a scale before its edge leaves the frame. */
  const boundX = (s: number) => {
    'worklet';
    return (width.value * (s - 1)) / 2;
  };
  const boundY = (s: number) => {
    'worklet';
    return (height.value * (s - 1)) / 2;
  };
  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    tx.value = withTiming(0);
    ty.value = withTiming(0);
    savedScale.value = 1;
  };
  /** After a gesture: snap back to 1 if barely zoomed, otherwise pull the edges back into the frame. */
  const settle = () => {
    'worklet';
    if (scale.value < ZOOMED_AT) return reset();
    savedScale.value = scale.value;
    tx.value = withTiming(clamp(tx.value, -boundX(scale.value), boundX(scale.value)));
    ty.value = withTiming(clamp(ty.value, -boundY(scale.value), boundY(scale.value)));
  };

  const announce = (z: boolean) => {
    setZoomed(z);
    onZoomChange?.(z);
  };
  useAnimatedReaction(
    () => scale.value >= ZOOMED_AT,
    (z, prev) => {
      if (prev !== null && z !== prev) scheduleOnRN(announce, z);
    },
    [],
  );
  // If this unmounts while zoomed (the photo was decided from a button), give the parents their gestures back.
  useEffect(() => {
    if (!zoomed) return;
    return () => onZoomChange?.(false);
  }, [zoomed, onZoomChange]);

  const pinch = Gesture.Pinch()
    .onStart((e) => {
      pinching.value = true;
      fromFit.value = savedScale.value <= 1.001;
      originX.value = (e.focalX - width.value / 2 - tx.value) / scale.value;
      originY.value = (e.focalY - height.value / 2 - ty.value) / scale.value;
    })
    .onUpdate((e) => {
      const floor = canPinchOut && fromFit.value ? PINCH_OUT_FLOOR : 1;
      const s = clamp(savedScale.value * e.scale, floor, MAX_SCALE);
      scale.value = s;
      // Keep the image point that was under the fingers under the (moving) fingers.
      tx.value = e.focalX - width.value / 2 - originX.value * s;
      ty.value = e.focalY - height.value / 2 - originY.value * s;
    })
    .onEnd(() => {
      pinching.value = false;
      if (canPinchOut && fromFit.value && scale.value < PINCH_OUT_AT) {
        reset();
        scheduleOnRN(pinchedOut);
        return;
      }
      settle();
    });

  const pan = Gesture.Pan()
    .enabled(zoomed)
    .maxPointers(1)
    .onChange((e) => {
      if (pinching.value) return;
      // A little give past the edge; settle() pulls it back.
      const bx = boundX(scale.value) + 40;
      const by = boundY(scale.value) + 40;
      tx.value = clamp(tx.value + e.changeX, -bx, bx);
      ty.value = clamp(ty.value + e.changeY, -by, by);
    })
    .onEnd(() => settle());

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .onEnd((e) => {
      if (scale.value >= ZOOMED_AT) return reset();
      const s = DOUBLE_TAP_SCALE;
      const px = e.x - width.value / 2;
      const py = e.y - height.value / 2;
      scale.value = withTiming(s);
      tx.value = withTiming(clamp(-px * (s - 1), -boundX(s), boundX(s)));
      ty.value = withTiming(clamp(-py * (s - 1), -boundY(s), boundY(s)));
      savedScale.value = s;
    });

  const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={[styles.frame, style]}
        testID={testID}
        onLayout={(e) => {
          width.value = e.nativeEvent.layout.width;
          height.value = e.nativeEvent.layout.height;
        }}
      >
        <Animated.View style={[StyleSheet.absoluteFill, imageStyle]}>
          <Image source={{ uri, cacheKey }} placeholder={placeholder ? { uri: placeholder } : undefined} contentFit="contain" transition={120} style={styles.image} cachePolicy="memory-disk" />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  image: { flex: 1 },
});
