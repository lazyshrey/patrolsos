/**
 * P.A.T.R.O.L. — mesh test harness.
 *
 * This is NOT the designed UI. It exists to answer one question on real
 * hardware: does connectionless BLE advertisement gossip actually relay a
 * packet from phone A to phone C through phone B, and does a status change
 * travel back the other way?
 *
 * The designed screens land once this is proven.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Location from 'expo-location';

import { MeshEngine } from './src/core/meshEngine';
import { BleTransport } from './src/transport/BleTransport';
import { sha256 } from './src/services/sha256';
import { callsign, generateNodeId } from './src/services/nodeIdentity';
import { shortId } from './src/proto/codec';
import { CATEGORY_LABEL, STATUS_LABEL, TRIAGE_LABEL, describe } from './src/proto/presets';
import { formatDistance, haversineMeters } from './src/core/geo';
import { Category, Status, Triage, type Incident, type PacketEvent, type PeerState } from './src/types';
import type { BleStatus } from './modules/patrol-ble/src/PatrolBleModule';

const C = {
  paper: '#FAF9F7',
  card: '#FFFFFF',
  line: '#E6E3DE',
  ink: '#1A1917',
  soft: '#6B6862',
  faint: '#9C978E',
  action: '#16324F',
  red: '#D0342C',
  amber: '#C2820E',
  green: '#2E7D4F',
};

const TRIAGE_COLOR: Record<number, string> = {
  0: C.red,
  1: C.amber,
  2: C.green,
  3: '#33312D',
  4: C.faint,
};

export default function App() {
  const nodeIdRef = useRef<number>(generateNodeId());
  const engineRef = useRef<MeshEngine | null>(null);
  const transportRef = useRef<BleTransport | null>(null);
  // Latest fix, kept in a ref so the presence timer never closes over stale state.
  const coordsRef = useRef<{ lat: number; lon: number } | null>(null);
  const presenceTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<BleStatus | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [log, setLog] = useState<PacketEvent[]>([]);
  const [stats, setStats] = useState({ heard: 0, relayed: 0, originated: 0, dropped: 0 });
  const [coords, setCoords] = useState<{ lat: number; lon: number; acc: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nodeId = nodeIdRef.current;

  const refreshStatus = useCallback(() => {
    try {
      setStatus(BleTransport.getStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 2000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  // Pull UI state off the engine on a timer rather than on every packet —
  // advertisement gossip fires far faster than React should re-render.
  useEffect(() => {
    const t = setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      setIncidents(e.getIncidents());
      setPeers(e.getPeers());
      setLog(e.getLog().slice(0, 40));
      setStats({ ...e.stats });
    }, 700);
    return () => clearInterval(t);
  }, []);

  const startMesh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const granted = await BleTransport.requestPermissions();
      if (!granted) {
        setError('Permissions denied. Grant Nearby devices + Location.');
        setBusy(false);
        return;
      }

      // GPS is optional for the relay test — fall back so the test still runs
      // indoors where a fix may never arrive.
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.granted) {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          const c = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            acc: pos.coords.accuracy ?? 0,
          };
          coordsRef.current = c;
          setCoords(c);

          watchRef.current = await Location.watchPositionAsync(
            { accuracy: Location.Accuracy.Balanced, distanceInterval: 5, timeInterval: 5000 },
            (p) => {
              const next = {
                lat: p.coords.latitude,
                lon: p.coords.longitude,
                acc: p.coords.accuracy ?? 0,
              };
              coordsRef.current = next;
              setCoords(next);
            }
          );
        }
      } catch {
        // no fix; originate() will use the fallback below
      }

      const transport = new BleTransport();
      const engine = new MeshEngine({ nodeId, transport, sha256 });
      transportRef.current = transport;
      engineRef.current = engine;

      await engine.start();

      // "I am here", every 15 s. This is what puts peers on the map.
      const beacon = () => {
        const c = coordsRef.current;
        if (c) engine.announcePresence(c.lat, c.lon);
      };
      beacon();
      presenceTimer.current = setInterval(beacon, 15_000);

      setRunning(true);
      refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [nodeId, refreshStatus]);

  const stopMesh = useCallback(async () => {
    setBusy(true);
    if (presenceTimer.current) clearInterval(presenceTimer.current);
    presenceTimer.current = null;
    watchRef.current?.remove();
    watchRef.current = null;
    try {
      await engineRef.current?.stop();
    } catch {
      // ignore
    }
    engineRef.current = null;
    transportRef.current = null;
    setRunning(false);
    setBusy(false);
    refreshStatus();
  }, [refreshStatus]);

  const sendReport = useCallback(
    (triage: Triage) => {
      const e = engineRef.current;
      if (!e) return;
      const base = coords ?? { lat: 28.613912, lon: 77.209021, acc: 0 };
      e.originate({
        // Jitter so repeated taps do not collapse into one packetId.
        lat: base.lat + (Math.random() - 0.5) * 0.002,
        lon: base.lon + (Math.random() - 0.5) * 0.002,
        category: Category.MEDICAL,
        triage,
        casualties: 1 + Math.floor(Math.random() * 8),
        descPreset: 1,
      });
    },
    [coords]
  );

  const advance = useCallback((inc: Incident) => {
    const e = engineRef.current;
    if (!e) return;
    const next = Math.min(inc.status + 1, 3) as Status;
    e.setStatus(inc.packetId, next);
  }, []);

  const checks: Array<[string, boolean | undefined]> = [
    ['Bluetooth on', status?.bluetoothEnabled],
    ['Can advertise', status?.advertisingSupported],
    ['Permissions', status?.permissionsGranted],
    ['Location services', status?.locationEnabled],
  ];

  const allGreen = checks.every(([, ok]) => ok);

  return (
    <View style={s.root}>
      <StatusBar barStyle="dark-content" backgroundColor={C.paper} />
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.title}>P.A.T.R.O.L.</Text>
        <Text style={s.subtitle}>
          {callsign(nodeId)} · node {nodeId} · {running ? 'mesh running' : 'stopped'}
        </Text>

        {/* Preflight */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Radio check</Text>
          {checks.map(([label, ok]) => (
            <View key={label} style={s.row}>
              <View style={[s.dot, { backgroundColor: ok ? C.green : C.red }]} />
              <Text style={s.rowText}>{label}</Text>
              <Text style={[s.rowValue, { color: ok ? C.green : C.red }]}>
                {ok ? 'ok' : 'no'}
              </Text>
            </View>
          ))}
          {!allGreen && (
            <Text style={s.hint}>
              All four must be green. Android hides BLE scan results when Location services
              are off, even with permissions granted.
            </Text>
          )}
          {coords && (
            <Text style={s.hint}>
              GPS {coords.lat.toFixed(5)}, {coords.lon.toFixed(5)} (±{Math.round(coords.acc)} m)
            </Text>
          )}
        </View>

        {error && (
          <View style={[s.card, { borderColor: C.red }]}>
            <Text style={{ color: C.red, fontSize: 14 }}>{error}</Text>
          </View>
        )}

        {/* Controls */}
        <Pressable
          style={[s.button, { backgroundColor: running ? '#8A867E' : C.action }]}
          onPress={running ? stopMesh : startMesh}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.buttonText}>{running ? 'Stop mesh' : 'Start mesh'}</Text>
          )}
        </Pressable>

        {running && (
          <View style={s.sendRow}>
            <Pressable style={[s.send, { backgroundColor: C.red }]} onPress={() => sendReport(Triage.RED)}>
              <Text style={s.sendText}>Send NOW</Text>
            </Pressable>
            <Pressable style={[s.send, { backgroundColor: C.amber }]} onPress={() => sendReport(Triage.YELLOW)}>
              <Text style={s.sendText}>Send SOON</Text>
            </Pressable>
            <Pressable style={[s.send, { backgroundColor: C.green }]} onPress={() => sendReport(Triage.GREEN)}>
              <Text style={s.sendText}>Send WAIT</Text>
            </Pressable>
          </View>
        )}

        {/* Stats */}
        <View style={s.statRow}>
          <Stat label="heard" value={stats.heard} />
          <Stat label="relayed" value={stats.relayed} />
          <Stat label="sent" value={stats.originated} />
          <Stat label="dropped" value={stats.dropped} />
        </View>

        {/* Peers — the dataset a map layer would render */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Peers ({peers.length})</Text>
          {peers.length === 0 && <Text style={s.hint}>No other phones heard yet.</Text>}
          {peers.map((p) => {
            const here = coords;
            const dist =
              here && p.lat != null && p.lon != null
                ? formatDistance(haversineMeters(here, { lat: p.lat, lon: p.lon }))
                : null;
            return (
              <View key={p.nodeId} style={s.row}>
                <View
                  style={[
                    s.dot,
                    { backgroundColor: p.hops === 0 ? C.green : C.amber },
                  ]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={s.rowText}>{callsign(p.nodeId)}</Text>
                  <Text style={s.incMeta}>
                    {p.hops === 0 ? 'direct' : `via relay · ${p.hops} hops`} · {p.rssi} dBm ·{' '}
                    {p.packetsHeard} pkts
                  </Text>
                  <Text style={s.incMeta}>
                    {p.lat != null
                      ? `${p.lat.toFixed(5)}, ${p.lon!.toFixed(5)}${dist ? ` · ${dist} away` : ''}`
                      : 'position unknown'}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>

        {/* Incidents */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Incidents ({incidents.length})</Text>
          {incidents.length === 0 && <Text style={s.hint}>Nothing yet.</Text>}
          {incidents.map((inc) => (
            <Pressable key={inc.packetId} style={s.incident} onPress={() => advance(inc)}>
              <View style={[s.bar, { backgroundColor: TRIAGE_COLOR[inc.triage] }]} />
              <View style={{ flex: 1 }}>
                <Text style={s.incTitle}>
                  {describe(inc.descPreset)} {inc.mine ? '· yours' : ''}
                </Text>
                <Text style={s.incMeta}>
                  {CATEGORY_LABEL[inc.category]} · {TRIAGE_LABEL[inc.triage]} · {inc.casualties} ppl
                </Text>
                <Text style={s.incMeta}>
                  {shortId(inc.packetId)} · hops {inc.hops} · from {inc.originNodeId} · lam{' '}
                  {inc.lamport}
                </Text>
                <Text style={[s.incStatus, { color: TRIAGE_COLOR[inc.triage] }]}>
                  {STATUS_LABEL[inc.status]} — tap to advance
                </Text>
              </View>
            </Pressable>
          ))}
        </View>

        {/* Log */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Packet trace</Text>
          {log.length === 0 && <Text style={s.hint}>No traffic yet.</Text>}
          {log.map((ev, i) => (
            <Text key={i} style={s.logLine}>
              <Text style={{ color: dirColor(ev.dir) }}>{ev.dir.toUpperCase().padEnd(6)}</Text>
              {shortId(ev.packetId)} {ev.note}
            </Text>
          ))}
        </View>

        <Text style={s.footer}>
          Test: start the mesh on all three phones. Send from A. Keep B between A and C.
          C should show the incident with hops 1+. Then tap it on C to advance status and
          watch it come back on A.
        </Text>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function dirColor(dir: PacketEvent['dir']): string {
  if (dir === 'rx') return C.green;
  if (dir === 'tx') return C.action;
  if (dir === 'merge') return C.amber;
  return C.faint;
}

const mono = Platform.select({ android: 'monospace', default: 'Menlo' });

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.paper },
  scroll: { padding: 18, paddingTop: 54, paddingBottom: 60, gap: 14 },
  title: { fontSize: 26, fontWeight: '600', color: C.ink },
  subtitle: { fontSize: 14, color: C.faint, marginTop: -8 },
  card: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: '600', color: C.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 9, height: 9, borderRadius: 999 },
  rowText: { flex: 1, fontSize: 15, color: C.ink },
  rowValue: { fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 13, color: C.faint, lineHeight: 19 },
  button: { height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  sendRow: { flexDirection: 'row', gap: 8 },
  send: { flex: 1, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  statRow: { flexDirection: 'row', gap: 8 },
  stat: {
    flex: 1,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    padding: 10,
  },
  statValue: { fontSize: 20, fontWeight: '600', color: C.ink },
  statLabel: { fontSize: 12, color: C.faint },
  incident: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#F0EEEA',
  },
  bar: { width: 4, borderRadius: 999 },
  incTitle: { fontSize: 15, fontWeight: '500', color: C.ink },
  incMeta: { fontSize: 12, color: C.faint, fontFamily: mono },
  incStatus: { fontSize: 13, fontWeight: '500', marginTop: 2 },
  logLine: { fontSize: 11, color: C.soft, fontFamily: mono },
  footer: { fontSize: 13, color: C.faint, lineHeight: 19 },
});
