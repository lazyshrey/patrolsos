/**
 * Epidemic gossip engine.
 *
 * Nodes advertise 20-byte packets and scan continuously. Hearing an unknown
 * packet means: store it, merge it, and add it to your own broadcast rotation
 * with ttl-1. Spread emerges from nothing but advertise + scan.
 *
 * THE SUBTLE BUG THIS AVOIDS (see PLAN.md 1.3): rebroadcast must NOT be gated
 * on packetId alone. A status update carries the SAME packetId with a higher
 * lamport; keying the seen-set on packetId would silently swallow it and
 * bidirectional sync would never work.
 *
 *   seenSet        keyed packetId:lamport:status  -> controls rebroadcast
 *   incidentStore  keyed packetId                 -> controls state
 */

import type {
  Incident,
  Packet,
  PacketEvent,
  PeerState,
  Status,
  Transport,
  Triage,
} from '../types';
import { Category } from '../types';
import { DEFAULT_TTL, MAX_HOPS, decodePacket, encodePacket, shortId } from '../proto/codec';
import { computePacketId, type Sha256Fn } from '../proto/packetId';
import { incidentFromPacket, mergeIncident, nextLamport } from './crdt';
import { Outbox, type OutboxEntry } from './outbox';
import {
  estimateLocation,
  type LocationEstimate,
  type Observation,
} from './localization';
import {
  BUZZ_ALL,
  BUZZ_STALE_MS,
  BUZZ_TTL,
  BuzzGate,
  DEFAULT_RING_SECONDS,
  answerFromPacket,
  buzzFromPacket,
  clampRingSeconds,
  pressKey,
  type BuzzAnswer,
  type BuzzRequest,
} from './buzz';

const SEEN_CAP = 2000;
const ROTATION_CAP = 24;
const LOG_CAP = 200;
const GC_INTERVAL_MS = 60_000;
const RESOLVED_TTL_MS = 30 * 60 * 1000;
const STORE_CAP = 5000;

/** Presence is local-interest only — no point flooding the whole mesh with it. */
const PRESENCE_TTL = 2;

/**
 * Observations travel a little further than presence: the node doing the
 * trilateration (typically base) is usually not one of the observers.
 */
const OBSERVATION_TTL = 4;

/** Stop trusting an observation after this long — people move. */
const OBSERVATION_STALE_MS = 5 * 60 * 1000;

/**
 * How long a peer stays marked "ringing" on the strength of one answer.
 *
 * A phone whose alarm is sounding re-answers every few seconds, so this only
 * has to outlast the gap between answers — not the whole alarm.
 */
const RINGING_MS = 15_000;

/** An answer is worth re-broadcasting for about as long as it is true. */
const ANSWER_AIRTIME_MS = 30_000;

/** Slack on top of the ring duration, so late joiners still hear the call. */
const BUZZ_AIRTIME_SLACK_MS = 15_000;

/**
 * RSSI is negative and roughly -30..-110 dBm. Store the magnitude so it fits a
 * u8 byte, and clamp to a sane band so a corrupt byte cannot imply a wild range.
 */
function encodeRssi(rssi: number): number {
  return Math.min(200, Math.max(20, Math.round(-rssi)));
}

function decodeRssi(byte: number): number {
  return -Math.min(200, Math.max(20, byte));
}

/**
 * No packet from a peer for this long means it is gone.
 *
 * Neither Android's scanner nor iOS CoreBluetooth gives a reliable "peer lost"
 * callback, so loss has to be inferred from silence. (Same conclusion as
 * protestchat, MIT licensed.)
 */
export const PEER_STALE_MS = 30_000;

export interface MeshEngineOptions {
  nodeId: number;
  transport: Transport;
  sha256: Sha256Fn;
  /** Injected so tests control time. */
  now?: () => number;
  onChange?: () => void;
  /**
   * Fires once per genuine press of somebody's buzz button — echoes and relayed
   * copies of the same press are swallowed. Check `forMe` before making noise;
   * a buzz aimed at someone else is still worth knowing about, because it means
   * a phone near you is about to start ringing.
   */
  onBuzz?: (buzz: BuzzRequest) => void;
}

export interface OriginateInput {
  lat: number;
  lon: number;
  category: Category;
  triage: Triage;
  casualties: number;
  descPreset: number;
}

export class MeshEngine {
  readonly nodeId: number;

  private transport: Transport;
  private sha256: Sha256Fn;
  private now: () => number;
  private onChange?: () => void;
  private onBuzzCb?: (buzz: BuzzRequest) => void;

  private incidents = new Map<number, Incident>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private peers = new Map<number, PeerState>();
  private observations = new Map<string, Observation>();
  private buzzes = new Map<string, BuzzRequest>();
  private answers = new Map<number, BuzzAnswer>();
  private buzzGate: BuzzGate;
  private log: PacketEvent[] = [];

  /**
   * Packets that stop being true after a while. A buzz is a moment, not a
   * fact: keeping one in the rotation once its alarm has finished would spend
   * radio time announcing an emergency that is over.
   */
  private ephemeral = new Map<number, number>();

  private lamport = 0;
  private rotation: Packet[] = [];
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  /** Queue of packets we authored, with echo-based delivery receipts. */
  readonly outbox: Outbox;

  /** Counters for the Network screen. */
  stats = { heard: 0, relayed: 0, originated: 0, dropped: 0 };

  constructor(opts: MeshEngineOptions) {
    this.nodeId = opts.nodeId;
    this.transport = opts.transport;
    this.sha256 = opts.sha256;
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange;
    this.onBuzzCb = opts.onBuzz;
    this.outbox = new Outbox(this.now);
    this.buzzGate = new BuzzGate(this.now);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.transport.onReceive((bytes, rssi) => this.handleBytes(bytes, rssi));
    this.transport.onPeer((peer) => {
      this.peers.set(peer.nodeId, peer);
      this.emit();
    });
    await this.transport.start(this.nodeId);
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
    // Do not hold the node event loop open in tests.
    (this.gcTimer as unknown as { unref?: () => void }).unref?.();
  }

  async stop(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.gcTimer = null;
    await this.transport.stop();
  }

  // -------------------------------------------------------------------------
  // Originating
  // -------------------------------------------------------------------------

  originate(input: OriginateInput): Packet {
    const at = this.now();
    this.lamport = nextLamport(this.lamport, this.lamport);

    const packetId = computePacketId(
      this.sha256,
      input.lat,
      input.lon,
      input.category,
      this.nodeId,
      at
    );

    const packet: Packet = {
      packetId,
      lat: input.lat,
      lon: input.lon,
      category: input.category,
      triage: input.triage,
      casualties: input.casualties,
      ttl: DEFAULT_TTL,
      hops: 0,
      lamport: this.lamport,
      status: 0 as Status,
      descPreset: input.descPreset,
      originNodeId: this.nodeId,
    };

    this.ingest(packet, at, true);
    this.markSeen(this.seenKey(packet));
    this.enqueue(packet);
    this.outbox.add(packet);
    this.stats.originated++;
    this.pushLog('tx', packetId, `new ${shortId(packetId)} ttl ${packet.ttl}`);
    this.rebuildRotation();
    this.emit();
    return packet;
  }

  /**
   * "I am here." Broadcasts this node's own position so peers can be drawn on
   * the map. Same 20-byte frame, low TTL, and it replaces any previous presence
   * from this node in the rotation rather than piling up.
   */
  announcePresence(lat: number, lon: number, batteryPercent = 255): Packet {
    const at = this.now();
    this.lamport = nextLamport(this.lamport, this.lamport);

    const packet: Packet = {
      packetId: computePacketId(this.sha256, lat, lon, Category.PRESENCE, this.nodeId, at),
      lat,
      lon,
      category: Category.PRESENCE,
      triage: 4 as Triage,
      // The spare byte carries battery level. A relay network made of phones
      // needs to know which of its relays are about to die: 255 means unknown.
      casualties: Math.min(255, Math.max(0, Math.round(batteryPercent))),
      ttl: PRESENCE_TTL,
      hops: 0,
      lamport: this.lamport,
      status: 0 as Status,
      descPreset: 0,
      originNodeId: this.nodeId,
    };

    this.markSeen(this.seenKey(packet));
    this.enqueue(packet);
    this.rebuildRotation();
    this.emit();
    return packet;
  }

  /**
   * "I heard node `target` at `rssi`, and I was standing here."
   *
   * Only meaningful if WE have a real GPS fix — an observation from an unknown
   * position tells nobody anything, so callers must not invent coordinates.
   */
  announceObservation(targetNodeId: number, rssi: number, lat: number, lon: number): Packet {
    const at = this.now();
    this.lamport = nextLamport(this.lamport, this.lamport);

    const packet: Packet = {
      packetId: computePacketId(this.sha256, lat, lon, Category.OBSERVATION, this.nodeId, at),
      lat,
      lon,
      category: Category.OBSERVATION,
      triage: 4 as Triage,
      // Two spare bytes carry the whole observation.
      casualties: targetNodeId & 0xff,
      descPreset: encodeRssi(rssi),
      ttl: OBSERVATION_TTL,
      hops: 0,
      lamport: this.lamport,
      status: 0 as Status,
      originNodeId: this.nodeId,
    };

    this.recordObservation(packet, at);
    this.markSeen(this.seenKey(packet));
    this.enqueue(packet);
    this.rebuildRotation();
    this.emit();
    return packet;
  }

  /**
   * Emit observations for every peer we can currently hear, so other nodes can
   * trilaterate them. Call on a timer. No-op without our own GPS fix.
   */
  sweepObservations(lat: number, lon: number, max = 4): number {
    const fresh = this.getPeers()
      .filter((p) => p.rssi !== 0)
      .slice(0, max);
    for (const p of fresh) {
      this.announceObservation(p.nodeId, p.rssi, lat, lon);
    }
    return fresh.length;
  }

  /**
   * Ring a phone — or every phone in earshot — and ask it to say where it is.
   *
   * `lat`/`lon` are OUR position, so whoever starts ringing knows which
   * direction the call came from. Pass 0,0 when there is no fix; the buzz still
   * works, it just cannot say where the caller stood.
   */
  sendBuzz(
    targetNodeId: number = BUZZ_ALL,
    lat = 0,
    lon = 0,
    seconds: number = DEFAULT_RING_SECONDS
  ): Packet {
    const at = this.now();
    // The press id. Bumping the clock first is what makes two presses
    // distinguishable to everyone downstream.
    this.lamport = nextLamport(this.lamport, this.lamport);

    const packet: Packet = {
      packetId: computePacketId(this.sha256, lat, lon, Category.BUZZ, this.nodeId, at),
      lat,
      lon,
      category: Category.BUZZ,
      triage: 4 as Triage,
      casualties: targetNodeId & 0xff,
      ttl: BUZZ_TTL,
      hops: 0,
      lamport: this.lamport,
      status: 0 as Status,
      descPreset: clampRingSeconds(seconds),
      originNodeId: this.nodeId,
    };

    // Consume our own press so an echo of it can never ring us back.
    this.buzzGate.admit(buzzFromPacket(packet, this.nodeId, at));
    this.markSeen(this.seenKey(packet));
    this.enqueue(packet);
    this.ephemeral.set(
      packet.packetId,
      at + clampRingSeconds(seconds) * 1000 + BUZZ_AIRTIME_SLACK_MS
    );
    this.pushLog(
      'tx',
      packet.packetId,
      targetNodeId === BUZZ_ALL
        ? `buzz all · ${packet.descPreset}s`
        : `buzz node ${targetNodeId} · ${packet.descPreset}s`
    );
    this.rebuildRotation();
    this.emit();
    return packet;
  }

  /**
   * "I am ringing, and this is where I am." Sent by the phone being rung.
   *
   * Called repeatedly while the alarm sounds rather than once: each answer is a
   * fresh position, and the searcher walking towards the noise is exactly the
   * person who benefits from an updated one.
   */
  answerBuzz(callerNodeId: number, lat = 0, lon = 0, batteryPercent = 255): Packet {
    const at = this.now();
    this.lamport = nextLamport(this.lamport, this.lamport);

    const packet: Packet = {
      packetId: computePacketId(this.sha256, lat, lon, Category.BUZZ_ACK, this.nodeId, at),
      lat,
      lon,
      category: Category.BUZZ_ACK,
      triage: 4 as Triage,
      casualties: callerNodeId & 0xff,
      ttl: BUZZ_TTL,
      hops: 0,
      lamport: this.lamport,
      status: 0 as Status,
      descPreset: Math.min(255, Math.max(0, Math.round(batteryPercent))),
      originNodeId: this.nodeId,
    };

    this.markSeen(this.seenKey(packet));
    this.enqueue(packet);
    this.ephemeral.set(packet.packetId, at + ANSWER_AIRTIME_MS);
    this.pushLog('tx', packet.packetId, `answering buzz from ${callerNodeId}`);
    this.rebuildRotation();
    this.emit();
    return packet;
  }

  /** Advance an incident's status and gossip the change back out. */
  setStatus(packetId: number, status: Status): Packet | null {
    const inc = this.incidents.get(packetId);
    if (!inc) return null;
    if (status <= inc.status) return null; // lattice: never regress

    const at = this.now();
    this.lamport = nextLamport(this.lamport, inc.lamport);

    const packet: Packet = {
      packetId,
      lat: inc.lat,
      lon: inc.lon,
      category: inc.category,
      triage: inc.triage,
      casualties: inc.casualties,
      ttl: DEFAULT_TTL,
      hops: 0,
      lamport: this.lamport,
      status,
      descPreset: inc.descPreset,
      originNodeId: this.nodeId,
    };

    this.ingest(packet, at, false);
    this.markSeen(this.seenKey(packet));
    this.enqueue(packet);
    this.outbox.add(packet);
    this.pushLog('tx', packetId, `status -> ${status}`);
    this.rebuildRotation();
    this.emit();
    return packet;
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  private handleBytes(bytes: Uint8Array, rssi: number): void {
    const packet = decodePacket(bytes);
    if (!packet) {
      this.stats.dropped++;
      return;
    }
    this.receive(packet, rssi);
  }

  receive(packet: Packet, rssi = 0): void {
    const at = this.now();
    const key = this.seenKey(packet);

    // DELIVERY RECEIPT. A packet carrying our own originNodeId with hops > 0 is
    // proof some other device picked it up and chose to carry it onward.
    //
    // This MUST run before the seen-set check: we marked our own packet seen the
    // moment we authored it, so the echo would otherwise be suppressed here and
    // the receipt lost.
    if (packet.originNodeId === this.nodeId && packet.hops > 0) {
      if (this.outbox.noteEcho(packet.packetId)) {
        this.pushLog('rx', packet.packetId, `delivered — relayed by a peer`);
        this.emit();
      }
    }

    // PEER LIVENESS MUST ALSO RUN BEFORE THE SEEN CHECK.
    //
    // In a steady state almost everything we hear is a duplicate — each node
    // re-advertises its rotation about once a second. If liveness only updated
    // on genuinely NEW packets, a peer standing right next to you with nothing
    // new to say would go stale after PEER_STALE_MS and disappear from the peer
    // list, and its signal meter would freeze at whatever it last happened to
    // be. Hearing a duplicate is still hearing them.
    this.touchPeer(packet, rssi, at);

    if (this.seen.has(key)) {
      this.stats.dropped++;
      this.pushLog('drop', packet.packetId, 'already seen');
      return;
    }

    this.markSeen(key);
    this.stats.heard++;
    this.pushLog('rx', packet.packetId, `ttl ${packet.ttl} hops ${packet.hops}`);

    // Presence, observations and buzzes are peer metadata, not incidents.
    switch (packet.category) {
      case Category.OBSERVATION:
        this.recordObservation(packet, at);
        break;
      case Category.BUZZ:
        this.recordBuzz(packet, at);
        break;
      case Category.BUZZ_ACK:
        this.recordAnswer(packet, at);
        break;
      case Category.PRESENCE:
        break;
      default:
        this.ingest(packet, at, false);
    }

    // Relay with a decremented hop budget.
    if (packet.ttl > 0) {
      const relayed: Packet = {
        ...packet,
        ttl: packet.ttl - 1,
        hops: Math.min(packet.hops + 1, MAX_HOPS),
      };
      this.enqueue(relayed);
      // A relayed ring needs the same deadline as an originated one, or we
      // would keep announcing an alarm that finished ten minutes ago.
      if (isRingPacket(relayed)) {
        this.ephemeral.set(
          relayed.packetId,
          at +
            (relayed.category === Category.BUZZ
              ? clampRingSeconds(relayed.descPreset) * 1000 + BUZZ_AIRTIME_SLACK_MS
              : ANSWER_AIRTIME_MS)
        );
      }
      this.stats.relayed++;
      this.pushLog('tx', packet.packetId, `relay ttl ${relayed.ttl}`);
    }

    this.rebuildRotation();
    this.emit();
  }

  /** Merge a packet into the incident store without touching the rotation. */
  private ingest(packet: Packet, at: number, mine: boolean): void {
    // Keep our clock ahead of anything we have seen.
    if (packet.lamport > this.lamport) this.lamport = packet.lamport;

    const existing = this.incidents.get(packet.packetId);
    if (!existing) {
      this.incidents.set(packet.packetId, incidentFromPacket(packet, at, mine));
    } else {
      const merged = mergeIncident(existing, packet, at);
      merged.mine = existing.mine || mine;
      this.incidents.set(packet.packetId, merged);
      this.pushLog('merge', packet.packetId, `status ${merged.status}`);
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast rotation
  // -------------------------------------------------------------------------

  /**
   * File an observation. Keyed on observer+target so a node moving around
   * refines its reading rather than piling up stale ones.
   */
  private recordObservation(packet: Packet, at: number): void {
    const targetNodeId = packet.casualties;
    // An observation of ourselves tells us nothing we do not already know.
    if (targetNodeId === this.nodeId) return;

    this.observations.set(`${packet.originNodeId}:${targetNodeId}`, {
      observerNodeId: packet.originNodeId,
      observer: { lat: packet.lat, lon: packet.lon },
      targetNodeId,
      rssi: decodeRssi(packet.descPreset),
      at,
    });
  }

  /**
   * File a heard buzz and, if this is the first time we have seen this press,
   * tell the app about it.
   *
   * Note the ordering: the buzz is stored for the UI whatever the gate decides,
   * because "node 47 is ringing everyone nearby" is worth showing even on a
   * phone that is rate-limited out of joining in.
   */
  private recordBuzz(packet: Packet, at: number): void {
    const buzz = buzzFromPacket(packet, this.nodeId, at);
    if (buzz.callerNodeId === this.nodeId) return; // our own, come back around

    const key = pressKey(buzz.callerNodeId, buzz.press);
    const known = this.buzzes.get(key);
    // Keep the shortest path we have heard this press by — it is the honest
    // one, and later copies arrive by longer routes.
    if (!known || buzz.hops < known.hops) this.buzzes.set(key, buzz);

    const admitted = this.buzzGate.admit(buzz);
    this.pushLog(
      'rx',
      packet.packetId,
      admitted
        ? `buzz from ${buzz.callerNodeId} — ringing ${buzz.seconds}s`
        : `buzz from ${buzz.callerNodeId}${buzz.forMe ? ' (held back)' : ' (not for us)'}`
    );

    // Fired for every new press, ours to ring for or not: a phone that hears
    // someone else being rung should look around and report what it hears, so
    // the caller can place the phone that is about to start screaming.
    if (!known) this.onBuzzCb?.({ ...buzz, forMe: admitted });
  }

  /** File somebody's answer to a buzz. Keyed on responder — newest wins. */
  private recordAnswer(packet: Packet, at: number): void {
    const answer = answerFromPacket(packet, at);
    if (answer.responderNodeId === this.nodeId) return;
    const prev = this.answers.get(answer.responderNodeId);
    if (prev && prev.at > answer.at) return;
    this.answers.set(answer.responderNodeId, answer);
  }

  /** Ours, and no peer has echoed it back yet. */
  private isUnsent(p: Packet): boolean {
    if (p.originNodeId !== this.nodeId) return false;
    return this.outbox.get(p.packetId)?.state === 'pending';
  }

  /** Add or replace a packet in the rotation, newest version wins. */
  private enqueue(packet: Packet): void {
    const stale = (p: Packet) =>
      p.packetId === packet.packetId ||
      // Only the newest presence per node is worth broadcasting — otherwise a
      // moving peer fills the rotation with its own breadcrumb trail.
      (packet.category === Category.PRESENCE &&
        p.category === Category.PRESENCE &&
        p.originNodeId === packet.originNodeId) ||
      // Likewise one observation per observer-target pair: repeated readings of
      // the same peer supersede each other rather than accumulating.
      (packet.category === Category.OBSERVATION &&
        p.category === Category.OBSERVATION &&
        p.originNodeId === packet.originNodeId &&
        p.casualties === packet.casualties) ||
      // A caller only ever has one live buzz, and a phone only one live answer.
      // Without this, holding the button down would fill the rotation with
      // presses and crowd out the incident reports.
      ((packet.category === Category.BUZZ || packet.category === Category.BUZZ_ACK) &&
        p.category === packet.category &&
        p.originNodeId === packet.originNodeId);

    this.rotation = [packet, ...this.rotation.filter((p) => !stale(p))];
  }

  /**
   * Android advertises one payload at a time, so we cycle. Priority keeps the
   * most urgent packets in the pool when it overflows.
   */
  private rebuildRotation(): void {
    const at = this.now();
    const byId = new Map<number, Packet>();
    for (const p of this.rotation) {
      const expires = this.ephemeral.get(p.packetId);
      if (expires != null && at >= expires) {
        this.ephemeral.delete(p.packetId);
        continue;
      }
      byId.set(p.packetId, p);
    }

    const ranked = [...byId.values()].sort((a, b) => {
      // A buzz outranks everything, in both directions. It is the only packet
      // in the protocol with a deadline measured in seconds: an alarm that
      // starts after the searcher has walked past is worse than no alarm.
      const ring = Number(isRingPacket(b)) - Number(isRingPacket(a));
      if (ring !== 0) return ring;

      // Then our own packets that nobody has echoed yet. They are the only
      // ones we KNOW have not got out, so they need the radio most.
      const unsent = Number(this.isUnsent(b)) - Number(this.isUnsent(a));
      if (unsent !== 0) return unsent;

      const sev = triageRank(a.triage) - triageRank(b.triage);
      if (sev !== 0) return sev;
      const unresolved = Number(a.status === 3) - Number(b.status === 3);
      if (unresolved !== 0) return unresolved;
      return b.lamport - a.lamport;
    });

    this.rotation = ranked.slice(0, ROTATION_CAP);
    for (const p of this.rotation) {
      if (p.originNodeId === this.nodeId) this.outbox.markBroadcast(p.packetId);
    }
    this.transport.setBroadcastSet(this.rotation.map(encodePacket));
  }

  // -------------------------------------------------------------------------
  // Seen set (bounded LRU)
  // -------------------------------------------------------------------------

  private seenKey(p: Packet): string {
    return `${p.packetId}:${p.lamport}:${p.status}`;
  }

  private markSeen(key: string): void {
    this.seen.add(key);
    this.seenOrder.push(key);
    while (this.seenOrder.length > SEEN_CAP) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  private touchPeer(packet: Packet, rssi: number, at: number): void {
    const nodeId = packet.originNodeId;
    if (nodeId === this.nodeId) return;
    const prev = this.peers.get(nodeId);
    const isPresence = packet.category === Category.PRESENCE;
    const isAnswer = packet.category === Category.BUZZ_ACK;
    // Packets whose coordinates are the SENDER's own rather than an incident's.
    // An answer to a buzz is the most valuable of the three: it is a position
    // deliberately published by someone who has just been asked for it.
    const selfLocating = isPresence || isAnswer || packet.category === Category.BUZZ;
    // 0,0 is what a phone with no fix sends. Believing it would stack every
    // unlocated peer on one spot in the Gulf of Guinea.
    const statesPosition = selfLocating && !(packet.lat === 0 && packet.lon === 0);

    // Raw RSSI jumps 10+ dB between consecutive packets from a stationary
    // phone — body position, orientation and multipath all move it. An
    // exponential moving average turns a twitching bar into one that tracks
    // real movement. Only smooth a DIRECT reading: a relayed packet's RSSI is
    // the strength of the relay, not of the original sender.
    const direct = packet.hops === 0;
    const smoothed =
      direct && prev && prev.rssi !== 0 ? Math.round(prev.rssi * 0.7 + rssi * 0.3) : rssi;

    // A presence packet can arrive by a slow relay path long after a fresher
    // one came direct. Accepting it would drag the peer's pin backwards to
    // where they used to be, so position only ever moves forward in logical
    // time.
    const fresherFromSender =
      selfLocating &&
      (prev?.presenceLamport == null || packet.lamport >= prev.presenceLamport);
    const fresherPresence = fresherFromSender && statesPosition;

    // Route quality has to be able to degrade. Sticky "best ever" hops would
    // keep showing someone as directly reachable long after they walked out of
    // range, because relayed copies keep the entry alive.
    const heardDirectlyRecently =
      direct || (prev?.lastDirectAt != null && at - prev.lastDirectAt < PEER_STALE_MS);

    this.peers.set(nodeId, {
      nodeId,
      rssi: direct ? smoothed : (prev?.rssi ?? rssi),
      lastSeen: at,
      lastDirectAt: direct ? at : prev?.lastDirectAt,
      packetsHeard: (prev?.packetsHeard ?? 0) + 1,
      hops: heardDirectlyRecently ? 0 : packet.hops,
      // Only a presence packet states where the peer itself is. An incident
      // packet's coordinates are the incident's, not the sender's.
      lat: fresherPresence ? packet.lat : prev?.lat,
      lon: fresherPresence ? packet.lon : prev?.lon,
      presenceLamport: fresherPresence ? packet.lamport : prev?.presenceLamport,
      // Presence carries battery in the casualties byte; an answer carries it
      // in descPreset, because its casualties byte names who it is answering.
      battery: (fresherFromSender ? batteryFrom(packet) : undefined) ?? prev?.battery,
      // An answer means "my alarm is going off right now". It is refreshed
      // every few seconds for as long as that stays true.
      ringingUntil: isAnswer ? at + RINGING_MS : prev?.ringingUntil,
    });
  }

  private gc(): void {
    const at = this.now();

    // Peer loss is inferred from silence — no platform gives a reliable callback.
    for (const [id, peer] of this.peers) {
      if (at - peer.lastSeen > PEER_STALE_MS) this.peers.delete(id);
    }

    for (const [key, o] of this.observations) {
      if (at - o.at > OBSERVATION_STALE_MS) this.observations.delete(key);
    }

    for (const [key, b] of this.buzzes) {
      if (at - b.at > BUZZ_STALE_MS) this.buzzes.delete(key);
    }
    for (const [id, expires] of this.ephemeral) {
      if (at >= expires) this.ephemeral.delete(id);
    }
    for (const [id, a] of this.answers) {
      if (at - a.at > BUZZ_STALE_MS) this.answers.delete(id);
    }
    // Retires finished buzzes from the broadcast rotation.
    this.rebuildRotation();

    this.outbox.sweep();

    for (const [id, inc] of this.incidents) {
      if (inc.status === 3 && at - inc.lastSeen > RESOLVED_TTL_MS) {
        this.incidents.delete(id);
      }
    }
    if (this.incidents.size > STORE_CAP) {
      const sorted = [...this.incidents.values()].sort(
        (a, b) => triageRank(a.triage) - triageRank(b.triage) || b.lastSeen - a.lastSeen
      );
      // Never evict RED, and never evict unresolved medical.
      for (const inc of sorted.reverse()) {
        if (this.incidents.size <= STORE_CAP) break;
        if (inc.triage === 0) continue;
        if (inc.category === 0 && inc.status !== 3) continue;
        this.incidents.delete(inc.packetId);
      }
    }
    this.emit();
  }

  private pushLog(dir: PacketEvent['dir'], packetId: number, note: string): void {
    this.log.unshift({ at: this.now(), dir, packetId, note });
    if (this.log.length > LOG_CAP) this.log.pop();
  }

  private emit(): void {
    this.onChange?.();
  }

  /**
   * Restore state saved before the app was killed.
   *
   * Restored incidents go straight into the store rather than through
   * receive(): they are already-merged local state, not something a peer just
   * told us, so re-running the relay logic would put stale packets back on the
   * air with a fresh hop budget.
   *
   * The outbox IS re-broadcast: an undelivered report should keep trying.
   */
  hydrate(incidents: Incident[], outboxEntries: OutboxEntry[]): void {
    for (const inc of incidents) {
      this.incidents.set(inc.packetId, inc);
      if (inc.lamport > this.lamport) this.lamport = inc.lamport;
    }

    this.outbox.load(outboxEntries);
    for (const entry of this.outbox.pending()) {
      this.enqueue(entry.packet);
      this.markSeen(this.seenKey(entry.packet));
    }

    this.rebuildRotation();
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Bulk sync (Wi-Fi Direct)
  // -------------------------------------------------------------------------

  /**
   * Every incident we hold, as concatenated 20-byte packets.
   *
   * BLE dribbles one packet per advertising slot; over a Wi-Fi Direct socket we
   * can hand a peer the whole store at once. A few hundred incidents is a few
   * kilobytes — nothing for Wi-Fi.
   */
  exportAll(): Uint8Array {
    const incidents = [...this.incidents.values()];
    const out = new Uint8Array(incidents.length * 20);
    incidents.forEach((inc, i) => {
      out.set(
        encodePacket({
          packetId: inc.packetId,
          lat: inc.lat,
          lon: inc.lon,
          category: inc.category,
          triage: inc.triage,
          casualties: inc.casualties,
          // Bulk-synced packets get a fresh hop budget: the receiver is a new
          // region of the mesh, not another hop along the same chain.
          ttl: DEFAULT_TTL,
          hops: Math.min(inc.hops + 1, MAX_HOPS),
          lamport: inc.lamport,
          status: inc.status,
          descPreset: inc.descPreset,
          originNodeId: inc.originNodeId,
        }),
        i * 20
      );
    });
    return out;
  }

  /**
   * Feed a peer's whole store in. Each packet goes through the SAME receive()
   * path as one heard over BLE, so dedup, the status lattice and Lamport LWW
   * all apply unchanged. Returns how many packets were accepted.
   */
  importBulk(bytes: Uint8Array): number {
    let accepted = 0;
    for (let off = 0; off + 20 <= bytes.length; off += 20) {
      const packet = decodePacket(bytes.subarray(off, off + 20));
      if (!packet) {
        this.stats.dropped++;
        continue;
      }
      const before = this.incidents.size;
      this.receive(packet, 0);
      if (this.incidents.size > before) accepted++;
    }
    if (accepted > 0) this.pushLog('rx', 0, `wifi bulk sync: ${accepted} new`);
    return accepted;
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  getIncidents(): Incident[] {
    return [...this.incidents.values()].sort(
      (a, b) => triageRank(a.triage) - triageRank(b.triage) || b.lastSeen - a.lastSeen
    );
  }

  getIncident(packetId: number): Incident | undefined {
    return this.incidents.get(packetId);
  }

  getPeers(): PeerState[] {
    return [...this.peers.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  getObservations(): Observation[] {
    return [...this.observations.values()];
  }

  /** Every buzz press we have heard lately, newest first. */
  getBuzzes(): BuzzRequest[] {
    return [...this.buzzes.values()].sort((a, b) => b.at - a.at);
  }

  /** Who is currently ringing, and where they say they are. Newest first. */
  getAnswers(): BuzzAnswer[] {
    return [...this.answers.values()].sort((a, b) => b.at - a.at);
  }

  /**
   * Estimated positions for every node we have observations of.
   *
   * Deliberately excludes any node that has told us where it is via a presence
   * packet — a real GPS fix always beats an RSSI guess, and showing an
   * uncertainty circle over a phone that knows its own position is noise.
   */
  getLocationEstimates(): LocationEstimate[] {
    const all = this.getObservations();
    const targets = new Set(all.map((o) => o.targetNodeId));

    const out: LocationEstimate[] = [];
    for (const target of targets) {
      const peer = this.peers.get(target);
      if (peer?.lat != null) continue; // it knows where it is
      const est = estimateLocation(target, all);
      if (est) out.push(est);
    }
    return out.sort((a, b) => a.uncertaintyM - b.uncertaintyM);
  }

  getLog(): PacketEvent[] {
    return this.log;
  }

  getRotationSize(): number {
    return this.rotation.length;
  }
}

function isRingPacket(p: Packet): boolean {
  return p.category === Category.BUZZ || p.category === Category.BUZZ_ACK;
}

/** Battery percentage a packet states about its own sender, if any. */
function batteryFrom(p: Packet): number | undefined {
  if (p.category === Category.PRESENCE && p.casualties <= 100) return p.casualties;
  if (p.category === Category.BUZZ_ACK && p.descPreset <= 100) return p.descPreset;
  return undefined;
}

function triageRank(t: Triage): number {
  // RED first, then YELLOW, GREEN, UNKNOWN, BLACK last.
  const order: Record<number, number> = { 0: 0, 1: 1, 2: 2, 4: 3, 3: 4 };
  return order[t] ?? 5;
}
