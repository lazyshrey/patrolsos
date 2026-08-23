import { Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { C, s } from '../theme';
import { Glyph } from '../icons';
import { callsign } from '../../services/nodeIdentity';
import { haversineMeters } from '../../core/geo';
import { describeProximity } from '../../core/localization';
import { BUZZ_ALL, DEFAULT_RING_SECONDS } from '../../core/buzz';
import type { MeshState } from '../../state/useMesh';

function ago(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)} min ago`;
}

/**
 * Ringing a stranger's phone at full alarm volume is not a neutral act, and it
 * is irreversible from here — there is no unring. One tap of confirmation is
 * the right amount of friction: enough that nobody does it in a pocket, little
 * enough that nobody dies waiting for a dialog.
 */
function confirmRing(mesh: MeshState, targetNodeId: number, label: string) {
  Alert.alert(
    targetNodeId === BUZZ_ALL ? 'Ring every phone nearby?' : `Ring ${label}?`,
    targetNodeId === BUZZ_ALL
      ? `Every phone in range, and every phone theirs can reach, will sound a full-volume alarm for ${DEFAULT_RING_SECONDS} seconds and answer with where it is. Use this to find people who cannot answer.`
      : `Their phone will sound a full-volume alarm for ${DEFAULT_RING_SECONDS} seconds, through silent mode, and answer with where it is.`,
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Ring',
        style: 'destructive',
        onPress: () => {
          if (!mesh.buzz(targetNodeId)) {
            Alert.alert('The mesh is off', 'Start it from Checks before ringing anyone.');
          }
        },
      },
    ]
  );
}

export function NetworkScreen({ mesh }: { mesh: MeshState }) {
  const direct = mesh.peers.filter((p) => p.hops === 0).length;
  const relayed = mesh.peers.length - direct;

  const locationOff = mesh.bleStatus && !mesh.bleStatus.locationEnabled;

  // Answers go stale on their own — a phone stops answering when its alarm
  // ends — so "ringing now" is derived from freshness rather than remembered.
  const now = Date.now();
  const ringing = mesh.answers.filter((a) => now - a.at < 20_000);

  return (
    <ScrollView contentContainerStyle={s.body}>
      <Text style={s.title}>Network</Text>

      <View style={{ gap: 3 }}>
        <View style={s.row}>
          <View
            style={[
              s.dot,
              { width: 10, height: 10, backgroundColor: mesh.running ? C.wait : C.faint },
            ]}
          />
          <Text style={{ fontSize: 18, fontWeight: '500', color: C.ink }}>
            {mesh.running ? (mesh.peers.length > 0 ? 'Connected' : 'Listening') : 'Off'}
          </Text>
        </View>
        <Text style={[s.meta, { paddingLeft: 24 }]}>
          {mesh.peers.length} phone{mesh.peers.length === 1 ? '' : 's'} nearby ·{' '}
          {mesh.incidents.length} report{mesh.incidents.length === 1 ? '' : 's'} shared
        </Text>
      </View>

      {mesh.bridgeWarning && (
        <View
          style={[
            s.panel,
            { borderColor: C.soon, borderWidth: 2, backgroundColor: '#FFFBF3' },
          ]}
        >
          <Text style={{ fontSize: 17, fontWeight: '600', color: C.ink }}>
            You are holding this group together
          </Text>
          <Text style={[s.meta, { lineHeight: 22 }]}>{mesh.bridgeWarning}</Text>
          <Text style={s.quiet}>
            Your phone is currently the only link between them. If you need to move, try to
            leave a phone here, or move slowly so they can find another route.
          </Text>
        </View>
      )}

      {relayed > 0 && (
        <Text style={s.quiet}>
          {relayed} phone{relayed === 1 ? ' is' : 's are'} too far to reach directly. Others are
          passing their reports along.
        </Text>
      )}

      {locationOff && (
        <View style={[s.panel, { borderColor: C.soon }]}>
          <Text style={{ fontSize: 15, color: C.ink }}>Turn on Location to find more phones</Text>
          <Text style={s.quiet}>Android needs it for Bluetooth scanning, even with permission granted.</Text>
        </View>
      )}

      <View style={[s.panel, { gap: 12 }]}>
        <View style={s.row}>
          <Glyph name="bell" color={C.ink} size={20} />
          <Text style={[s.sectionLabel, { flex: 1 }]}>Find someone you cannot see</Text>
        </View>
        <Text style={s.quiet}>
          Ringing makes a phone sound a full-volume alarm, through silent mode, and answer with
          where it is. It works on a phone in a pocket with the screen off, and on one whose
          owner cannot reach it.
        </Text>
        <Pressable
          style={[
            s.primary,
            { height: 54, backgroundColor: mesh.running ? C.now : C.hairline },
          ]}
          onPress={() => confirmRing(mesh, BUZZ_ALL, 'everyone')}
          disabled={!mesh.running}
        >
          <Text style={s.primaryText}>Ring every phone nearby</Text>
        </Pressable>
        {!mesh.running && (
          <Text style={s.quiet}>The mesh is off — start it from Checks first.</Text>
        )}
      </View>

      {ringing.length > 0 && (
        <View style={[s.panel, { borderColor: C.now, borderWidth: 2 }]}>
          <Text style={{ fontSize: 17, fontWeight: '600', color: C.ink }}>
            {ringing.length} phone{ringing.length === 1 ? ' is' : 's are'} ringing now
          </Text>
          <Text style={s.quiet}>
            Listen for the alarm and walk towards it. These positions refresh every few seconds
            while the phone keeps sounding.
          </Text>
          {ringing.map((a) => {
            const d =
              mesh.fix && a.lat != null && a.lon != null
                ? haversineMeters(mesh.fix, { lat: a.lat, lon: a.lon })
                : null;
            return (
              <View key={a.responderNodeId} style={{ gap: 3, paddingTop: 8 }}>
                <Text style={s.rowText}>{callsign(a.responderNodeId)}</Text>
                <Text style={s.quiet}>
                  {d != null
                    ? `about ${Math.round(d / 10) * 10} m away`
                    : a.lat != null
                      ? 'position known, but this phone has no fix to compare it to'
                      : 'no satellite fix — see the estimate below'}
                  {a.hops > 0 ? ` · ${a.hops} hop${a.hops === 1 ? '' : 's'} away` : ' · direct'}
                  {a.battery != null ? ` · battery ${a.battery}%` : ''}
                </Text>
                {a.lat != null && a.lon != null && (
                  <Text style={s.code}>
                    {a.lat.toFixed(5)}, {a.lon.toFixed(5)}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      )}

      <View style={{ gap: 0 }}>
        <Text style={[s.sectionLabel, { paddingBottom: 8 }]}>Nearby</Text>
        {mesh.peers.length === 0 && (
          <Text style={s.quiet}>
            {mesh.running ? 'No other phones heard yet.' : 'The mesh is off.'}
          </Text>
        )}
        {mesh.peers.map((p) => {
          const gps =
            mesh.fix && p.lat != null && p.lon != null
              ? haversineMeters(mesh.fix, { lat: p.lat, lon: p.lon })
              : null;
          const prox = describeProximity({ hops: p.hops, rssi: p.rssi, gpsDistanceM: gps });
          const low = p.battery != null && p.battery <= 20;
          const rings = p.ringingUntil != null && p.ringingUntil > now;
          return (
            <View key={p.nodeId} style={s.listRow}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={s.rowText}>{callsign(p.nodeId)}</Text>
                <Text style={s.quiet}>
                  {prox.detail}
                  {p.battery != null ? ` · battery ${p.battery}%` : ''}
                </Text>
                {low && (
                  <Text style={{ fontSize: 13, color: C.soon }}>
                    Low battery — may drop off the network soon
                  </Text>
                )}
              </View>
              <Bars rssi={p.rssi} hops={p.hops} />
              <Pressable
                onPress={() => confirmRing(mesh, p.nodeId, callsign(p.nodeId))}
                disabled={!mesh.running}
                hitSlop={8}
                style={{
                  height: 40,
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: rings ? C.now : C.line,
                  backgroundColor: rings ? '#FFF4F3' : C.card,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: mesh.running ? (rings ? C.now : C.action) : C.faint,
                  }}
                >
                  {rings ? 'Ringing' : 'Ring'}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>

      {mesh.estimates.length > 0 && (
        <View>
          <Text style={[s.sectionLabel, { paddingBottom: 6 }]}>Estimated positions</Text>
          <Text style={[s.quiet, { paddingBottom: 8 }]}>
            These phones have no satellite fix. Their position is worked out from how strongly
            other phones hear them — treat it as an area to search, not a pin.
          </Text>
          {mesh.estimates.map((e) => (
            <View key={e.targetNodeId} style={s.listRow}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={s.rowText}>{callsign(e.targetNodeId)}</Text>
                <Text style={s.quiet}>
                  Within about {Math.round(e.uncertaintyM)} m · {e.observerCount} phone
                  {e.observerCount === 1 ? '' : 's'} heard it
                  {e.method === 'nearest-observer' ? ' · rough' : ''}
                </Text>
                <Text style={s.code}>
                  {e.lat.toFixed(5)}, {e.lon.toFixed(5)}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}

      <View>
        <Text style={[s.sectionLabel, { paddingBottom: 8 }]}>Your reports</Text>
        {mesh.outbox.length === 0 && <Text style={s.quiet}>You have not sent anything yet.</Text>}
        {mesh.outbox.map((e) => {
          const done = e.state === 'delivered';
          const dead = e.state === 'expired';
          return (
            <View key={e.packetId} style={s.listRow}>
              <View
                style={[s.dot, { backgroundColor: done ? C.wait : dead ? C.faint : C.soon }]}
              />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={s.rowText}>
                  {done
                    ? 'Picked up by the mesh'
                    : dead
                      ? 'Nobody ever picked it up'
                      : 'Waiting to be picked up'}
                </Text>
                <Text style={s.quiet}>{ago(e.createdAt)}</Text>
              </View>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

function Bars({ rssi, hops }: { rssi: number; hops: number }) {
  // A relayed peer's signal strength is the relay's, not theirs — showing bars
  // for it would be a confident lie, so show none.
  const level = hops > 0 ? 0 : rssi >= -60 ? 3 : rssi >= -75 ? 2 : 1;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 16 }}>
      {[6, 11, 16].map((h, i) => (
        <View
          key={h}
          style={{
            width: 4,
            height: h,
            borderRadius: 1,
            backgroundColor: i < level ? C.ink : C.hairline,
          }}
        />
      ))}
    </View>
  );
}
