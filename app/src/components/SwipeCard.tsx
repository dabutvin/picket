import { useEffect } from 'react';
import { useWindowDimensions, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Image } from 'expo-image';
import type { Photo } from '../lib/types';
import { colors } from '../lib/theme';

export type Decision = 'pick' | 'reject';

interface Props {
  photo: Photo;
  onDecision: (photo: Photo, decision: Decision) => void;
  /** Imperative trigger for the on-screen buttons. */
  commandRef?: React.MutableRefObject<((d: Decision) => void) | null>;
}

const SWIPE_FRACTION = 0.3; // of screen width
const VELOCITY = 900;

export function SwipeCard({ photo, onDecision, commandRef }: Props) {
  const { width } = useWindowDimensions();
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const threshold = width * SWIPE_FRACTION;

  const flyOut = (decision: Decision) => {
    'worklet';
    const dir = decision === 'pick' ? 1 : -1;
    x.value = withTiming(dir * width * 1.4, { duration: 220 }, (finished) => {
      if (finished) scheduleOnRN(onDecision, photo, decision);
    });
  };

  useEffect(() => {
    if (!commandRef) return;
    commandRef.current = (d) => flyOut(d);
    return () => {
      commandRef.current = null;
    };
    // flyOut closes over this card's shared values; a new card re-registers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandRef, photo.photoId]);

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .onUpdate((e) => {
      x.value = e.translationX;
      y.value = e.translationY * 0.4;
    })
    .onEnd((e) => {
      if (e.translationX > threshold || e.velocityX > VELOCITY) return flyOut('pick');
      if (e.translationX < -threshold || e.velocityX < -VELOCITY) return flyOut('reject');
      x.value = withSpring(0);
      y.value = withSpring(0);
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { rotate: `${interpolate(x.value, [-width, 0, width], [-14, 0, 14], Extrapolation.CLAMP)}deg` },
    ],
  }));
  const pickBadge = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, threshold], [0, 1], Extrapolation.CLAMP),
  }));
  const rejectBadge = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [-threshold, 0], [1, 0], Extrapolation.CLAMP),
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.card, cardStyle]}>
        <Image
          source={{ uri: photo.previewUrl }}
          placeholder={{ uri: photo.thumbUrl }}
          contentFit="contain"
          transition={120}
          style={styles.image}
          cachePolicy="memory-disk"
        />
        <Animated.View style={[styles.badge, styles.pick, pickBadge]}>
          <Text style={[styles.badgeText, { color: colors.pick }]}>PICK</Text>
        </Animated.View>
        <Animated.View style={[styles.badge, styles.reject, rejectBadge]}>
          <Text style={[styles.badgeText, { color: colors.reject }]}>SKIP</Text>
        </Animated.View>
        <View style={styles.meta}>
          <Text style={styles.fileName}>{photo.fileName}</Text>
          <Text style={styles.exif}>
            {[photo.shutter, photo.aperture, photo.iso && `ISO ${photo.iso}`, photo.lens].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    inset: 0,
    backgroundColor: colors.card,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  image: { flex: 1 },
  badge: {
    position: 'absolute',
    top: 24,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 3,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  pick: { left: 20, borderColor: colors.pick, transform: [{ rotate: '-12deg' }] },
  reject: { right: 20, borderColor: colors.reject, transform: [{ rotate: '12deg' }] },
  badgeText: { fontSize: 28, fontWeight: '800', letterSpacing: 2 },
  meta: { padding: 12, backgroundColor: 'rgba(0,0,0,0.6)' },
  fileName: { color: colors.text, fontWeight: '600' },
  exif: { color: colors.muted, fontSize: 12, marginTop: 2 },
});
