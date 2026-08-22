/**
 * Field diagnostics.
 *
 * Deliberately kept out of the main flow but NOT deleted: hop counts, packet
 * ids and the raw trace are what make a mesh problem diagnosable in the field.
 * Without them, "it isn't working" has no follow-up question.
 */

import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { C, s } from '../theme';
import { callsign } from '../../services/nodeIdentity';
import { shortId } from '../../proto/codec';
import { CATEGORY_LABEL, TRIAGE_LABEL } from '../../proto/presets';
import { Triage, type PacketEvent } from '../../types';
import type { MeshState } from '../../state/useMesh';

export function DiagnosticsScreen({ mesh }: { mesh: MeshState }) {
  const checks: Array<[string, boolean | undefined, string]> = [
    ['Bluetooth on', mesh.bleStatus?.bluetoothEnabled, 'Turn Bluetooth on'],
    [
      'Can advertise',
      mesh.bleStatus?.advertisingSupported,
      'This chipset cannot broadcast. Nothing in software fixes it.',
    ],
    ['Permissions', mesh.bleStatus?.permissionsGranted, 'Start the mesh and accept the prompts'],
    [
      'Location services',
      mesh.bleStatus?.locationEnabled,
      'Android hides scan results without it, even when permitted',
    ],
  ];

  return (
    <ScrollView contentContainerStyle={s.body}>
      <View style={{ gap: 4 }}>
        <Text style={s.title}>Diagnostics</Text>
        <Text style={s.subtitle}>
          {callsign(mesh.nodeId)} · node {mesh.nodeId} · {mesh.running ? 'running' : 'stopped'}
        </Text>
      </View>

      <Pressable
        style={[s.primary, { backgroundColor: mesh.running ? C.hairline : C.action, height: 52 }]}
        onPress={mesh.running ? mesh.stop : mesh.start}
        disabled={mesh.busy}
      >
        {mesh.busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={s.primaryText}>{mesh.running ? 'Stop mesh' : 'Start mesh'}</Text>
        )}
      </Pressable>

      {mesh.error && (
        <View style={[s.panel, { borderColor: C.now }]}>
          <Text style={{ color: C.now, fontSize: 14 }}>{mesh.error}</Text>
        </View>
      )}

      <View style={s.panel}>
        <Text style={s.sectionLabel}>Radio check</Text>
        {checks.map(([label, ok, hint]) => (
          <View key={label} style={{ gap: 4 }}>
            <View style={s.row}>
              <View style={[s.dot, { backgroundColor: ok ? C.wait : C.now }]} />
              <Text style={[s.rowText, { flex: 1 }]}>{label}</Text>
              <Text style={{ fontSize: 14, fontWeight: '600', color: ok ? C.wait : C.now }}>
                {ok ? 'ok' : 'no'}
              </Text>
            </View>
            {!ok && <Text style={[s.quiet, { paddingLeft: 23 }]}>{hint}</Text>}
          </View>
        ))}
        {mesh.fix && (
          <Text style={s.code}>
            GPS {mesh.fix.lat.toFixed(5)}, {mesh.fix.lon.toFixed(5)} ±{Math.round(mesh.fix.acc)} m
          </Text>
        )}
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Stat label="heard" value={mesh.stats.heard} />
        <Stat label="relayed" value={mesh.stats.relayed} />
        <Stat label="sent" value={mesh.stats.originated} />
        <Stat label="dropped" value={mesh.stats.dropped} />
      </View>
      <Text style={s.quiet}>
        `dropped` climbing much faster than `heard` is correct — every phone re-advertises
        constantly, so you hear the same packet many times and ignore all but the first.
      </Text>

      <View style={s.panel}>
        <Text style={s.sectionLabel}>Raw incidents ({mesh.incidents.length})</Text>
        {mesh.incidents.length === 0 && <Text style={s.quiet}>None.</Text>}
        {mesh.incidents.slice(0, 12).map((inc) => (
          <View key={inc.packetId} style={{ gap: 2, paddingVertical: 4 }}>
            <Text style={s.code}>
              {shortId(inc.packetId)} · {CATEGORY_LABEL[inc.category]} ·{' '}
              {TRIAGE_LABEL[inc.triage as Triage]}
            </Text>
            <Text style={s.code}>
              hops {inc.hops} · from {inc.originNodeId} · lamport {inc.lamport} · status{' '}
              {inc.status}
              {inc.mine ? ' · mine' : ''}
            </Text>
          </View>
        ))}
      </View>

      <View style={s.panel}>
        <Text style={s.sectionLabel}>Observations ({mesh.estimates.length} estimates)</Text>
        <Text style={s.quiet}>
          Each observation is one phone reporting how strongly it heard another. Three of them
          about the same phone are enough to place it.
        </Text>
        {mesh.estimates.map((e) => (
          <Text key={e.targetNodeId} style={s.code}>
            node {e.targetNodeId} · ±{Math.round(e.uncertaintyM)} m · {e.observerCount} observers ·{' '}
            {e.method}
          </Text>
        ))}
      </View>

      <View style={s.panel}>
        <Text style={s.sectionLabel}>Packet trace</Text>
        {mesh.log.length === 0 && <Text style={s.quiet}>No traffic yet.</Text>}
        {mesh.log.map((ev, i) => (
          <Text key={i} style={s.code}>
            <Text style={{ color: dirColor(ev.dir) }}>{ev.dir.toUpperCase().padEnd(6)}</Text>
            {shortId(ev.packetId)} {ev.note}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: C.card,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: 12,
        padding: 10,
      }}
    >
      <Text style={{ fontSize: 20, fontWeight: '600', color: C.ink }}>{value}</Text>
      <Text style={{ fontSize: 12, color: C.faint }}>{label}</Text>
    </View>
  );
}

function dirColor(dir: PacketEvent['dir']): string {
  if (dir === 'rx') return C.wait;
  if (dir === 'tx') return C.action;
  if (dir === 'merge') return C.soon;
  return C.faint;
}
