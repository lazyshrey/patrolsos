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
import {
  BUZZ_ALL,
  DEFAULT_RING_SECONDS,
  type BuzzAnswer,
  type BuzzRequest,
} from '../core/buzz';
import { callsign } from '../services/nodeIdentity';
import { ring, silence as silenceAlarm, onRingEnd } from '../services/alarm';
import {
  backgroundAvailable,
  backgroundStatus,
  notificationText,
  onBackgroundStopRequested,
  requestBatteryExemption as askBatteryExemption,
  requestNotificationPermission,
  startBackground,
  stopBackground,
  updateBackground,
} from '../services/background';
import type { ServiceStatus } from '../../modules/patrol-service/src/PatrolServiceModule';
import type { BleStatus } from '../../modules/patrol-ble/src/PatrolBleModule';
import type { Category, Incident, PacketEvent, PeerState, Status, Triage } from '../types';

const UI_TICK_MS = 800;
const PRESENCE_MS = 15_000;
const OBSERVATION_MS = 25_000;
const PERSIST_MS = 10_000;

/**
 * How often a ringing phone repeats its answer.
 *
 * Once is not enough: the searcher is walking, the phone may be moved, and a
 * single 20-byte advertisement is easily missed. Every few seconds for the
 * length of the alarm gives them a position that keeps improving as they close
 * in, which is exactly the window in which it matters.
 */
const ANSWER_MS = 5_000;

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
  service: ServiceStatus;
  /** False on a build without the foreground-service module. */
  backgroundAvailable: boolean;
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

  /** Set while somebody is ringing THIS phone. Drives the full-screen alert. */
  buzzing: BuzzRequest | null;
  /** Wall-clock moment our own alarm goes quiet, or null. */
  ringEndsAt: number | null;
  /** Buzzes heard lately, whoever they were aimed at. */
  buzzes: BuzzRequest[];
  /** Phones currently ringing in answer to a buzz, and where they say they are. */
  answers: BuzzAnswer[];

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
  /**
   * Ring a phone, or every phone in range, and ask it where it is.
   * Returns false when the mesh is off and there was nothing to send.
   */
  buzz: (targetNodeId?: number) => boolean;
  /** Silence our own alarm. Does not stop anybody else's. */
  silenceBuzz: () => void;
  requestBatteryExemption: () => Promise<boolean>;
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
  const answerTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notificationRef = useRef<string>('');

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
  const [service, setService] = useState<ServiceStatus>(() => backgroundStatus());
  const [buzzing, setBuzzing] = useState<BuzzRequest | null>(null);
  const [ringEndsAt, setRingEndsAt] = useState<number | null>(null);
  const [buzzes, setBuzzes] = useState<BuzzRequest[]>([]);
  const [answers, setAnswers] = useState<BuzzAnswer[]>([]);

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

  // Radio and background-service preflight, polled so the user sees Location
  // being switched on, or the service dying, without having to restart.
  useEffect(() => {
    const read = () => {
      try {
        setBleStatus(BleTransport.getStatus());
      } catch {
        /* module unavailable in this environment */
      }
      setService(backgroundStatus());
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
      setBuzzes(e.getBuzzes());
      setAnswers(e.getAnswers());

      // The lock screen is where most people will read this, so it only gets
      // rewritten when it would actually say something different.
      const text = notificationText({
        peers: peers.length,
        incidents: list.length,
        outboxPending: e.outbox.stats().pending,
      });
      if (text !== notificationRef.current) {
        notificationRef.current = text;
        void updateBackground('PATROL is on', text);
      }
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

  // ---------------------------------------------------------------------------
  // Buzz
  // ---------------------------------------------------------------------------

  /** Stop answering and stop making noise. Safe to call when already quiet. */
  const endRing = useCallback(() => {
    if (answerTimerRef.current) clearInterval(answerTimerRef.current);
    answerTimerRef.current = null;
    if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
    ringTimerRef.current = null;
    void silenceAlarm();
    setBuzzing(null);
    setRingEndsAt(null);
  }, []);

  /**
   * Somebody pressed their buzz button somewhere in range.
   *
   * Two responses, and the second one runs even when the buzz was not for us.
   *
   * If it IS for us: make noise, and start saying where we are. A one-shot
   * high-accuracy fix is worth the battery here — being rung is the single
   * moment in this app's life when an exact position matters most.
   *
   * Either way: file observations. Somebody near us is about to start ringing,
   * and a phone that reports how strongly it hears them is what turns "in this
   * block" into "in this stairwell". A buzz aimed at a stranger is still our
   * cue to help place them.
   */
  const handleBuzz = useCallback(
    (b: BuzzRequest) => {
      const engine = engineRef.current;
      if (!engine) return;

      const fix = fixRef.current;
      if (fix) engine.sweepObservations(fix.lat, fix.lon);

      if (!b.forMe) return;

      const who = `${callsign(b.callerNodeId)} is looking for you`;
      const detail = b.hops === 0
        ? 'They are close enough to hear this phone directly. Leave the sound on.'
        : `Relayed through ${b.hops} phone${b.hops === 1 ? '' : 's'}. Leave the sound on so they can find you.`;

      void ring(b.seconds, who, detail);
      setBuzzing(b);
      setRingEndsAt(Date.now() + b.seconds * 1000);

      // A sharper fix, asked for once. watchPositionAsync runs on Balanced to
      // save power; this is the moment to spend it.
      void Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest })
        .then((pos) => {
          const next = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            acc: pos.coords.accuracy ?? 0,
          };
          fixRef.current = next;
          setFix(next);
        })
        .catch(() => {
          // No fix. The answer still goes out, and the observers around us are
          // what will place this phone.
        });

      const answer = () => {
        const e = engineRef.current;
        if (!e) return;
        const f = fixRef.current;
        e.answerBuzz(b.callerNodeId, f?.lat ?? 0, f?.lon ?? 0, batteryRef.current ?? 255);
        if (f) e.announcePresence(f.lat, f.lon, batteryRef.current ?? 255);
      };

      answer();
      if (answerTimerRef.current) clearInterval(answerTimerRef.current);
      answerTimerRef.current = setInterval(answer, ANSWER_MS);

      if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
      ringTimerRef.current = setTimeout(endRing, b.seconds * 1000);
    },
    [endRing]
  );

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const granted = await BleTransport.requestPermissions();
      if (!granted) {
        setError('Bluetooth and location permissions are needed to reach nearby phones.');
        return;
      }

      // Asked for before the service starts, because a foreground service the
      // user cannot see is exactly what this notification exists to prevent.
      await requestNotificationPermission();

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
        onBuzz: (b) => handleBuzz(b),
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

      // The background job. Started only once the radio is actually up, so the
      // notification never claims a mesh that failed to come on.
      notificationRef.current = notificationText({ peers: 0, incidents: 0, outboxPending: 0 });
      await startBackground('PATROL is on', notificationRef.current);
      setService(backgroundStatus());

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
  }, [handleBuzz]);

  const stop = useCallback(async () => {
    setBusy(true);
    endRing();
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
    // Drop the notification last: while it is up the process is protected, and
    // the radio teardown above is the part that must not be interrupted.
    await stopBackground();
    notificationRef.current = '';
    setService(backgroundStatus());
    setBuzzes([]);
    setAnswers([]);
    setRunning(false);
    setBusy(false);
  }, [endRing]);

  // The Stop button on the ongoing notification. Without this the service
  // would go away and leave the radio advertising into nothing.
  useEffect(() => {
    const sub = onBackgroundStopRequested(() => {
      void stop();
    });
    return () => sub.remove();
  }, [stop]);

  // The alarm can also end by itself, natively, after its deadline.
  useEffect(() => {
    const sub = onRingEnd(() => endRing());
    return () => sub.remove();
  }, [endRing]);

  // An alarm that outlives the component nobody can see is a phone nobody can
  // shut up. The foreground service is deliberately NOT torn down here: it
  // exists precisely to survive the UI going away.
  useEffect(() => endRing, [endRing]);

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

  const buzz = useCallback<MeshState['buzz']>((targetNodeId = BUZZ_ALL) => {
    const engine = engineRef.current;
    if (!engine) return false;
    const f = fixRef.current;
    engine.sendBuzz(targetNodeId, f?.lat ?? 0, f?.lon ?? 0, DEFAULT_RING_SECONDS);
    // Confirmation in the hand: the caller cannot hear the phone they just rang.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    return true;
  }, []);

  const requestBatteryExemption = useCallback(async () => {
    const ok = await askBatteryExemption();
    setService(backgroundStatus());
    return ok;
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
    service,
    backgroundAvailable,
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
    buzzing,
    ringEndsAt,
    buzzes,
    answers,
    start,
    stop,
    report,
    setStatus,
    buzz,
    silenceBuzz: endRing,
    requestBatteryExemption,
    reset,
    restored,
  };
}
