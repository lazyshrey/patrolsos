import { ScrollView, Text, View } from 'react-native';

import { C, s } from '../theme';
import { callsign } from '../../services/nodeIdentity';
import { formatDistance, haversineMeters } from '../../core/geo';
import type { MeshState } from '../../state/useMesh';

function ago(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)} min ago`;
}

export function NetworkScreen({ mesh }: { mesh: MeshState }) {
  const direct = mesh.peers.filter((p) => p.hops === 0).length;
  const relayed = mesh.peers.length - direct;

  const locationOff = mesh.bleStatus && !mesh.bleStatus.locationEnabled;

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

      <View style={{ gap: 0 }}>
        <Text style={[s.sectionLabel, { paddingBottom: 8 }]}>Nearby</Text>
        {mesh.peers.length === 0 && (
          <Text style={s.quiet}>
            {mesh.running ? 'No other phones heard yet.' : 'The mesh is off.'}
          </Text>
        )}
        {mesh.peers.map((p) => {
          const dist =
            mesh.fix && p.lat != null && p.lon != null
              ? formatDistance(haversineMeters(mesh.fix, { lat: p.lat, lon: p.lon }))
              : null;
          return (
            <View key={p.nodeId} style={s.listRow}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={s.rowText}>{callsign(p.nodeId)}</Text>
                <Text style={s.quiet}>
                  {p.hops === 0 ? 'Direct' : `Through another phone · ${p.hops} hops`}
                  {dist ? ` · ${dist} away` : p.lat == null ? ' · position unknown' : ''}
                </Text>
              </View>
              <Bars rssi={p.rssi} />
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

function Bars({ rssi }: { rssi: number }) {
  // -50 strong, -90 weak.
  const level = rssi >= -60 ? 3 : rssi >= -75 ? 2 : 1;
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
