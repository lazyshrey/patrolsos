/**
 * What happens after you press Send.
 *
 * Broadcasting into a Bluetooth advertisement is completely invisible. Without
 * feedback the app feels broken at exactly the moment someone is most
 * frightened, so this takes over the screen and narrates the one thing they
 * care about: has anyone picked it up yet?
 *
 * It reports the truth and no more. "Picked up by 2 phones" means two devices
 * relayed the packet onward. It does not mean help is coming, and the wording
 * never implies it.
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';

import { C } from './theme';
import type { OutboxEntry } from '../core/outbox';

export function SendConfirmation({
  entry,
  colour,
  onDone,
}: {
  entry: OutboxEntry | null;
  colour: string;
  onDone: () => void;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();

    // A slow outward pulse, as long as we are still waiting to be heard.
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1800,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [fade, pulse]);

  const delivered = entry?.state === 'delivered';
  const echoes = entry?.echoes ?? 0;

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.6] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] });

  return (
    <Animated.View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: C.paper,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        gap: 28,
        opacity: fade,
      }}
    >
      <View style={{ width: 200, height: 200, alignItems: 'center', justifyContent: 'center' }}>
        {!delivered && (
          <Animated.View
            style={{
              position: 'absolute',
              width: 90,
              height: 90,
              borderRadius: 999,
              borderWidth: 2,
              borderColor: colour,
              transform: [{ scale: ringScale }],
              opacity: ringOpacity,
            }}
          />
        )}
        <View
          style={{
            width: 90,
            height: 90,
            borderRadius: 999,
            backgroundColor: delivered ? C.wait : colour,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {delivered ? (
            <View
              style={{
                width: 34,
                height: 18,
                borderLeftWidth: 4,
                borderBottomWidth: 4,
                borderColor: '#FFFFFF',
                transform: [{ rotate: '-45deg' }],
                marginTop: -8,
              }}
            />
          ) : (
            <View style={{ width: 14, height: 14, borderRadius: 999, backgroundColor: '#FFFFFF' }} />
          )}
        </View>
      </View>

      <View style={{ gap: 10, alignItems: 'center' }}>
        <Text style={{ fontSize: 24, fontWeight: '600', color: C.ink, textAlign: 'center' }}>
          {delivered ? 'Your report is moving' : 'Reaching out…'}
        </Text>
        <Text
          style={{ fontSize: 16, color: C.soft, textAlign: 'center', lineHeight: 24, maxWidth: 300 }}
        >
          {delivered
            ? `Picked up by ${echoes === 1 ? 'a nearby phone' : `${echoes} nearby phones`}, which are now carrying it onward.`
            : 'Broadcasting to any phone in range. This keeps trying even if nobody is nearby yet.'}
        </Text>
        {delivered && (
          <Text style={{ fontSize: 14, color: C.faint, textAlign: 'center', maxWidth: 300 }}>
            This confirms the message is spreading. It does not yet mean help is on the way.
          </Text>
        )}
      </View>

      <Pressable
        onPress={onDone}
        style={{
          height: 56,
          paddingHorizontal: 44,
          borderRadius: 16,
          backgroundColor: delivered ? C.action : C.card,
          borderWidth: 1,
          borderColor: delivered ? C.action : C.line,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text
          style={{
            fontSize: 16,
            fontWeight: '500',
            color: delivered ? '#FFFFFF' : C.ink,
          }}
        >
          {delivered ? 'Done' : 'Keep waiting in the background'}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
