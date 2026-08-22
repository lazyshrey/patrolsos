/**
 * The single place the app talks to the mesh.
 *
 * Everything below this hook is pure engine; everything above is presentation.
 * UI state is pulled off the engine on a timer rather than pushed per packet —
 * advertisement gossip fires far faster than React should re-render.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as Haptics from 'expo-haptics';

import { MeshEngine } from '../core/meshEngine';
import { BleTransport } from '../transport/BleTransport';
import { sha256 } from '../services/sha256';
import { generateNodeId } from '../services/nodeIdentity';
import {
  clearAll,
  initStorage,
  loadIncidents,
  loadNodeId,
  loadOutbox,
  saveIncidents,
  saveNodeId,
  saveOutbox,
} from '../services/storage';
import { clusterIncidents, type Cluster } from '../core/deduplicator';
import type { LocationEstimate } from '../core/localization';
import { analyseBridge, bridgeMessage, type BridgeStatus } from '../core/topology';
import type { OutboxEntry } from '../core/outbox';
import type { BleStatus } from '../../modules/patrol-ble/src/PatrolBleModule';
import type { Category, Incident, PacketEvent, PeerState, Status, Triage } from '../types';

const UI_TICK_MS = 800;
const PRESENCE_MS = 15_000;
const OBSERVATION_MS = 25_000;
const PERSIST_MS = 10_000;

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
  bridge: BridgeStatus;
  bridgeWarning: string | null;
  battery: number | null;
  outbox: OutboxEntry[];
  log: PacketEvent[];
  stats: { heard: number; relayed: number; originated: number; dropped: number };

  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Returns the packetId of the report just created, or null if not running. */
  report: (input: {
    category: Category;
    triage: Triage;
    casualties: number;
    descPreset: number;
  }) => number | null;
  setStatus: (packetId: number, status: Status) => void;
  reset: () => Promise<void>;
  restored: boolean;
}

export function useMesh(): MeshState {
  const nodeIdRef = useRef(generateNodeId());
  const hydratedRef = useRef(false);
  const engineRef = useRef<MeshEngine | null>(null);
  const fixRef = useRef<Fix | null>(null);
  const timers = useRef<Array<ReturnType<typeof setInterval>>>([]);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const batteryRef = useRef<number | null>(null);

  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bleStatus, setBleStatus] = useState<BleStatus | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [nodeId, setNodeId] = useState(nodeIdRef.current);
  const [restored, setRestored] = useState(false);

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [estimates, setEstimates] = useState<LocationEstimate[]>([]);
  const [bridge, setBridge] = useState<BridgeStatus>({
    isBridge: false,
    groups: [],
    isolated: [],
  });
  const [battery, setBattery] = useState<number | null>(null);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [log, setLog] = useState<PacketEvent[]>([]);
  const [stats, setStats] = useState({ heard: 0, relayed: 0, originated: 0, dropped: 0 });

  // Identity must survive a restart, or a phone looks like a brand new device
  // to its neighbours every time Android kills the app.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await initStorage();
      if (!ok || cancelled) return;
      let id = await loadNodeId();
      if (id == null) {
        id = generateNodeId();
        await saveNodeId(id);
      }
      if (cancelled) return;
      nodeIdRef.current = id;
      setNodeId(id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Our own battery, shared with peers so the network knows which relays are
  // about to die.
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const level = await Battery.getBatteryLevelAsync();
        if (!cancelled && level >= 0) {
          const pct = Math.round(level * 100);
          batteryRef.current = pct;
          setBattery(pct);
        }
      } catch {
        /* not available */
      }
    };
    void read();
    const t = setInterval(read, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

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
      const peers = e.getPeers();
      setIncidents(list);
      setClusters(clusterIncidents(list));
      setPeers(peers);
      setEstimates(e.getLocationEstimates());
      setBridge(analyseBridge(e.nodeId, peers, e.getObservations()));
      setOutbox(e.outbox.all());
      setLog(e.getLog().slice(0, 50));
      setStats({ ...e.stats });
    }, UI_TICK_MS);
    timers.current.push(t);
    return () => clearInterval(t);
  }, []);

  // Flush to disk on a slow timer. Writing on every packet would hammer the
  // database for no benefit — the mesh re-delivers anything lost in a 10 s gap.
  useEffect(() => {
    const t = setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      void saveIncidents(e.getIncidents());
      void saveOutbox(e.outbox.all());
    }, PERSIST_MS);
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
        // The ref, not the state: this callback has an empty dependency list,
        // so the state value here would still be the pre-load random id.
        nodeId: nodeIdRef.current,
        transport: new BleTransport(),
        sha256,
      });
      engineRef.current = engine;

      // Restore what we knew before the app was killed, once per launch.
      if (!hydratedRef.current) {
        hydratedRef.current = true;
        const [saved, savedOutbox] = await Promise.all([loadIncidents(), loadOutbox()]);
        if (saved.length > 0 || savedOutbox.length > 0) {
          engine.hydrate(saved, savedOutbox);
          setRestored(true);
        }
      }

      await engine.start();

      // "I am here" — puts this phone on other people's maps.
      const beacon = () => {
        const f = fixRef.current;
        if (f) engine.announcePresence(f.lat, f.lon, batteryRef.current ?? 255);
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
    if (!engine) return null;
    // Without a fix we still send: a report with a rough position beats silence,
    // and peers who hear it can trilaterate us.
    const f = fixRef.current ?? { lat: 0, lon: 0, acc: 0 };
    const packet = engine.originate({ lat: f.lat, lon: f.lon, ...input });
    // Something has to happen in the hand — the mesh is otherwise invisible.
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
      () => {}
    );
    // Push the new entry into UI state immediately rather than waiting for the
    // next tick, so the confirmation screen has something to track at once.
    setOutbox(engine.outbox.all());
    return packet.packetId;
  }, []);

  const setStatus = useCallback<MeshState['setStatus']>((packetId, status) => {
    engineRef.current?.setStatus(packetId, status);
  }, []);

  const reset = useCallback(async () => {
    await clearAll();
    setRestored(false);
  }, []);

  return {
    nodeId,
    running,
    busy,
    error,
    bleStatus,
    fix,
    incidents,
    clusters,
    peers,
    estimates,
    bridge,
    bridgeWarning: bridgeMessage(bridge),
    battery,
    outbox,
    log,
    stats,
    start,
    stop,
    report,
    setStatus,
    reset,
    restored,
  };
}
