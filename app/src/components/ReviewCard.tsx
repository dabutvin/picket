import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { Decision, Photo } from '../lib/types';
import { colors } from '../lib/theme';
import { captureTime, exifLine } from '../lib/format';
import { ZoomableImage } from './ZoomableImage';

/** What a flick on the card means: up promotes to Picks, down demotes to Skipped. */
export type CardDecision = Extract<Decision, 'pick' | 'reject'>;

interface Props {
  photo: Photo;
  /** Only the card in the middle of the carousel takes flicks and button commands. */
  active: boolean;
  onDecision: (photo: Photo, decision: CardDecision) => void;
  /** Imperative trigger for the on-screen buttons; registered by the active card. */
  commandRef?: React.MutableRefObject<((d: CardDecision) => void) | null>;
  /** The photo is zoomed in: the carousel should stop browsing until it is zoomed out. */
  onZoomChange?: (zoomed: boolean) => void;
}

const SWIPE_FRACTION = 0.22; // of screen height
const VELOCITY = 800;

/**
 * One photo in the Review carousel. A vertical pan flicks it off the screen (up = pick,
 * down = skip); horizontal movement is left to the carousel around it. Each card owns its
 * animation values, so the card that replaces a decided one always starts at rest. While the
 * photo is zoomed, one finger pans the photo instead of flicking.
 */
export function ReviewCard({ photo, active, onDecision, commandRef, onZoomChange }: Props) {
  const { height } = useWindowDimensions();
  const y = useSharedValue(0);
  const [zoomed, setZoomed] = useState(false);
  const zoomChanged = (z: boolean) => {
    setZoomed(z);
    onZoomChange?.(z);
  };
  const threshold = height * SWIPE_FRACTION;

  const flyOut = (decision: CardDecision) => {
    'worklet';
    const dir = decision === 'pick' ? -1 : 1;
    y.value = withTiming(dir * height * 1.1, { duration: 240 }, (finished) => {
      if (finished) scheduleOnRN(onDecision, photo, decision);
    });
  };

  useEffect(() => {
    if (!commandRef || !active) return;
    commandRef.current = (d) => flyOut(d);
    return () => {
      if (commandRef.current) commandRef.current = null;
    };
    // flyOut closes over this card's shared value; the next active card re-registers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandRef, active, photo.photoId]);

  const pan = Gesture.Pan()
    .enabled(active && !zoomed)
    .maxPointers(1)
    .activeOffsetY([-14, 14])
    .failOffsetX([-18, 18])
    .onUpdate((e) => {
      y.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY < -threshold || e.velocityY < -VELOCITY) return flyOut('pick');
      if (e.translationY > threshold || e.velocityY > VELOCITY) return flyOut('reject');
      y.value = withSpring(0, { damping: 18, stiffness: 220 });
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }, { scale: interpolate(Math.abs(y.value), [0, threshold], [1, 0.96], Extrapolation.CLAMP) }],
    opacity: interpolate(Math.abs(y.value), [height * 0.5, height * 1.1], [1, 0.2], Extrapolation.CLAMP),
  }));
  const pickStamp = useAnimatedStyle(() => ({ opacity: interpolate(y.value, [-threshold, 0], [1, 0], Extrapolation.CLAMP) }));
  const skipStamp = useAnimatedStyle(() => ({ opacity: interpolate(y.value, [0, threshold], [0, 1], Extrapolation.CLAMP) }));
  const dim = useAnimatedStyle(() => ({ opacity: interpolate(Math.abs(y.value), [0, threshold], [0, 0.35], Extrapolation.CLAMP) }));

  const time = captureTime(photo.capturedAt);
  const exif = exifLine(photo);

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.card, cardStyle]}>
        <ZoomableImage uri={photo.previewUrl} placeholder={photo.thumbUrl} style={styles.image} onZoomChange={zoomChanged} testID={active ? 'review-image' : undefined} />
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.dim, dim]} />
        <Animated.View pointerEvents="none" style={[styles.stamp, styles.stampTop, pickStamp]}>
          <Text style={[styles.stampText, { color: colors.pick }]}>PICK</Text>
        </Animated.View>
        <Animated.View pointerEvents="none" style={[styles.stamp, styles.stampBottom, skipStamp]}>
          <Text style={[styles.stampText, { color: colors.reject }]}>SKIP</Text>
        </Animated.View>
        <View style={styles.meta}>
          <View style={styles.metaRow}>
            <Text style={styles.fileName}>{photo.fileName}</Text>
            {!!time && <Text style={styles.time}>{time}</Text>}
          </View>
          {!!exif && <Text style={styles.exif}>{exif}</Text>}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  image: { flex: 1 },
  dim: { backgroundColor: '#000' },
  stamp: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 3,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  stampTop: { top: 28, borderColor: colors.pick },
  stampBottom: { bottom: 84, borderColor: colors.reject },
  stampText: { fontSize: 30, fontWeight: '800', letterSpacing: 3 },
  meta: { padding: 12, backgroundColor: 'rgba(0,0,0,0.6)', gap: 2 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  fileName: { color: colors.text, fontWeight: '600', flexShrink: 1 },
  time: { color: colors.muted, fontSize: 12 },
  exif: { color: colors.muted, fontSize: 12 },
});
