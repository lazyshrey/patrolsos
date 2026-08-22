/**
 * The single place the app talks to the mesh.
 *
 * Everything below this hook is pure engine; everything above is presentation.
 * UI state is pulled off the engine on a timer rather than pushed per packet —
 * advertisement gossip fires far faster than React should re-render.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';

import { MeshEngine } from '../core/meshEngine';
import { BleTransport } from '../transport/BleTransport';
import { sha256 } from '../services/sha256';
import { generateNodeId } from '../services/nodeIdentity';
import { clusterIncidents, type Cluster } from '../core/deduplicator';
import type { LocationEstimate } from '../core/localization';
import type { OutboxEntry } from '../core/outbox';
import type { BleStatus } from '../../modules/patrol-ble/src/PatrolBleModule';
import type { Category, Incident, PacketEvent, PeerState, Status, Triage } from '../types';

const UI_TICK_MS = 800;
const PRESENCE_MS = 15_000;
const OBSERVATION_MS = 25_000;

export interface Fix {
  lat: number;
  lon: number;
  acc: number;
}

export interface MeshState {
  nodeId: number;
  running: boolean;
  busy: boolean;
  error: string | null;
  bleStatus: BleStatus | null;
  fix: Fix | null;

  incidents: Incident[];
  clusters: Cluster[];
  peers: PeerState[];
  estimates: LocationEstimate[];
  outbox: OutboxEntry[];
  log: PacketEvent[];
  stats: { heard: number; relayed: number; originated: number; dropped: number };

  start: () => Promise<void>;
  stop: () => Promise<void>;
  report: (input: {
    category: Category;
    triage: Triage;
    casualties: number;
    descPreset: number;
  }) => void;
  setStatus: (packetId: number, status: Status) => void;
}

export function useMesh(): MeshState {
  const nodeIdRef = useRef(generateNodeId());
  const engineRef = useRef<MeshEngine | null>(null);
  const fixRef = useRef<Fix | null>(null);
  const timers = useRef<Array<ReturnType<typeof setInterval>>>([]);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bleStatus, setBleStatus] = useState<BleStatus | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [estimates, setEstimates] = useState<LocationEstimate[]>([]);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [log, setLog] = useState<PacketEvent[]>([]);
  const [stats, setStats] = useState({ heard: 0, relayed: 0, originated: 0, dropped: 0 });

  // Radio preflight, polled so the user sees Location being switched on.
  useEffect(() => {
    const read = () => {
      try {
        setBleStatus(BleTransport.getStatus());
      } catch {
        /* module unavailable in this environment */
      }
    };
    read();
    const t = setInterval(read, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const list = e.getIncidents();
      setIncidents(list);
      setClusters(clusterIncidents(list));
      setPeers(e.getPeers());
      setEstimates(e.getLocationEstimates());
      setOutbox(e.outbox.all());
      setLog(e.getLog().slice(0, 50));
      setStats({ ...e.stats });
    }, UI_TICK_MS);
    timers.current.push(t);
    return () => clearInterval(t);
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const granted = await BleTransport.requestPermissions();
      if (!granted) {
        setError('Bluetooth and location permissions are needed to reach nearby phones.');
        return;
      }

      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.granted) {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          const f = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            acc: pos.coords.accuracy ?? 0,
          };
          fixRef.current = f;
          setFix(f);

          watchRef.current = await Location.watchPositionAsync(
            { accuracy: Location.Accuracy.Balanced, distanceInterval: 5, timeInterval: 5000 },
            (p) => {
              const next = {
                lat: p.coords.latitude,
                lon: p.coords.longitude,
                acc: p.coords.accuracy ?? 0,
              };
              fixRef.current = next;
              setFix(next);
            }
          );
        }
      } catch {
        // No fix. The mesh still works; we just cannot place anything.
      }

      const engine = new MeshEngine({
        nodeId: nodeIdRef.current,
        transport: new BleTransport(),
        sha256,
      });
      engineRef.current = engine;
      await engine.start();

      // "I am here" — puts this phone on other people's maps.
      const beacon = () => {
        const f = fixRef.current;
        if (f) engine.announcePresence(f.lat, f.lon);
      };
      beacon();
      timers.current.push(setInterval(beacon, PRESENCE_MS));

      // "I heard these phones, at this strength, from here" — lets a phone with
      // no GPS of its own be located by the people around it.
      timers.current.push(
        setInterval(() => {
          const f = fixRef.current;
          if (f) engine.sweepObservations(f.lat, f.lon);
        }, OBSERVATION_MS)
      );

      setRunning(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    for (const t of timers.current) clearInterval(t);
    timers.current = [];
    watchRef.current?.remove();
    watchRef.current = null;
    try {
      await engineRef.current?.stop();
    } catch {
      /* already down */
    }
    engineRef.current = null;
    setRunning(false);
    setBusy(false);
  }, []);

  const report = useCallback<MeshState['report']>((input) => {
    const engine = engineRef.current;
    if (!engine) return;
    // Without a fix we still send: a report with a rough position beats silence,
    // and peers who hear it can trilaterate us.
    const f = fixRef.current ?? { lat: 0, lon: 0, acc: 0 };
    engine.originate({ lat: f.lat, lon: f.lon, ...input });
  }, []);

  const setStatus = useCallback<MeshState['setStatus']>((packetId, status) => {
    engineRef.current?.setStatus(packetId, status);
  }, []);

  return {
    nodeId: nodeIdRef.current,
    running,
    busy,
    error,
    bleStatus,
    fix,
    incidents,
    clusters,
    peers,
    estimates,
    outbox,
    log,
    stats,
    start,
    stop,
    report,
    setStatus,
  };
}
