/**
 * The screen a person sees when their phone is being rung.
 *
 * It covers everything, deliberately. This is not a notification competing for
 * attention with the rest of the app — a rescuer is trying to find this phone,
 * and the only two things that matter are that the person understands what is
 * happening and that they do not silence it by reflex.
 *
 * So: no dismiss gesture, no back-out, one button, and that button says what it
 * costs. The alarm ends on its own when the countdown runs out.
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import { C, s } from './theme';
import { callsign } from '../services/nodeIdentity';
import { haversineMeters } from '../core/geo';
import type { BuzzRequest } from '../core/buzz';
import type { Fix } from '../state/useMesh';

export function BuzzAlert({
  buzz,
  endsAt,
  fix,
  onSilence,
}: {
  buzz: BuzzRequest;
  endsAt: number | null;
  fix: Fix | null;
  onSilence: () => void;
}) {
  const [left, setLeft] = useState(() => remaining(endsAt));

  useEffect(() => {
    setLeft(remaining(endsAt));
    const t = setInterval(() => setLeft(remaining(endsAt)), 500);
    return () => clearInterval(t);
  }, [endsAt]);

  const distance =
    fix && buzz.lat != null && buzz.lon != null
      ? haversineMeters(fix, { lat: buzz.lat, lon: buzz.lon })
      : null;

  return (
    <Modal visible animationType="fade" transparent={false} onRequestClose={() => {}}>
      <View style={{ flex: 1, backgroundColor: C.now, padding: 26, justifyContent: 'space-between' }}>
        <View style={{ paddingTop: 70, gap: 18 }}>
          <Text style={{ fontSize: 15, color: '#FFFFFF', opacity: 0.85, letterSpacing: 1.2 }}>
            SOMEONE IS LOOKING FOR YOU
          </Text>

          <Text style={{ fontSize: 40, fontWeight: '700', color: '#FFFFFF', letterSpacing: -0.8 }}>
            {callsign(buzz.callerNodeId)}
          </Text>

          <Text style={{ fontSize: 19, color: '#FFFFFF', opacity: 0.92, lineHeight: 28 }}>
            {where(buzz, distance)}
          </Text>

          <View style={{ height: 1, backgroundColor: '#FFFFFF', opacity: 0.25 }} />

          <Text style={{ fontSize: 17, color: '#FFFFFF', opacity: 0.92, lineHeight: 26 }}>
            Your phone is sounding so they can hear where you are, and it is telling them your
            position every few seconds.
          </Text>

          <Text style={{ fontSize: 16, color: '#FFFFFF', opacity: 0.75, lineHeight: 24 }}>
            If you can, leave it ringing and stay where you are.
          </Text>
        </View>

        <View style={{ gap: 14, paddingBottom: 30 }}>
          <Text style={{ fontSize: 15, color: '#FFFFFF', opacity: 0.75, textAlign: 'center' }}>
            {left > 0 ? `Stops by itself in ${left}s` : 'Stopping'}
          </Text>

          <Pressable
            style={[
              s.primary,
              { backgroundColor: 'rgba(0,0,0,0.28)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
            ]}
            onPress={onSilence}
          >
            <Text style={s.primaryText}>Silence — I am safe and found</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function remaining(endsAt: number | null): number {
  if (endsAt == null) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

/**
 * What we honestly know about where the caller is. Hop count is the reliable
 * part; a metre figure only appears when both phones have a fix.
 */
function where(buzz: BuzzRequest, distanceM: number | null): string {
  if (distanceM != null) {
    const rounded =
      distanceM < 1000
        ? `${Math.round(distanceM / 10) * 10} m away`
        : `${(distanceM / 1000).toFixed(1)} km away`;
    return `About ${rounded}${buzz.hops === 0 ? ', close enough to hear this phone directly' : ''}.`;
  }
  if (buzz.hops === 0) return 'They are close by — near enough to hear this phone directly.';
  return `Their call reached you through ${buzz.hops} other phone${buzz.hops === 1 ? '' : 's'}.`;
}
