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

const SEEN_CAP = 2000;
const ROTATION_CAP = 24;
const LOG_CAP = 200;
const GC_INTERVAL_MS = 60_000;
const RESOLVED_TTL_MS = 30 * 60 * 1000;
const STORE_CAP = 5000;

/** Presence is local-interest only — no point flooding the whole mesh with it. */
const PRESENCE_TTL = 2;

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

  private incidents = new Map<number, Incident>();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private peers = new Map<number, PeerState>();
  private log: PacketEvent[] = [];

  private lamport = 0;
  private rotation: Packet[] = [];
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  /** Counters for the Network screen. */
  stats = { heard: 0, relayed: 0, originated: 0, dropped: 0 };

  constructor(opts: MeshEngineOptions) {
    this.nodeId = opts.nodeId;
    this.transport = opts.transport;
    this.sha256 = opts.sha256;
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange;
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
  announcePresence(lat: number, lon: number): Packet {
    const at = this.now();
    this.lamport = nextLamport(this.lamport, this.lamport);

    const packet: Packet = {
      packetId: computePacketId(this.sha256, lat, lon, Category.PRESENCE, this.nodeId, at),
      lat,
      lon,
      category: Category.PRESENCE,
      triage: 4 as Triage,
      casualties: 0,
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

    if (this.seen.has(key)) {
      this.stats.dropped++;
      this.pushLog('drop', packet.packetId, 'already seen');
      return;
    }

    this.markSeen(key);
    this.stats.heard++;
    this.touchPeer(packet, rssi, at);
    this.pushLog('rx', packet.packetId, `ttl ${packet.ttl} hops ${packet.hops}`);

    // Presence is peer metadata, not an incident — never goes in the store.
    if (packet.category !== Category.PRESENCE) {
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

  /** Add or replace a packet in the rotation, newest version wins. */
  private enqueue(packet: Packet): void {
    const stale = (p: Packet) =>
      p.packetId === packet.packetId ||
      // Only the newest presence per node is worth broadcasting — otherwise a
      // moving peer fills the rotation with its own breadcrumb trail.
      (packet.category === Category.PRESENCE &&
        p.category === Category.PRESENCE &&
        p.originNodeId === packet.originNodeId);

    this.rotation = [packet, ...this.rotation.filter((p) => !stale(p))];
  }

  /**
   * Android advertises one payload at a time, so we cycle. Priority keeps the
   * most urgent packets in the pool when it overflows.
   */
  private rebuildRotation(): void {
    const byId = new Map<number, Packet>();
    for (const p of this.rotation) byId.set(p.packetId, p);

    const ranked = [...byId.values()].sort((a, b) => {
      const sev = triageRank(a.triage) - triageRank(b.triage);
      if (sev !== 0) return sev;
      const unresolved = Number(a.status === 3) - Number(b.status === 3);
      if (unresolved !== 0) return unresolved;
      return b.lamport - a.lamport;
    });

    this.rotation = ranked.slice(0, ROTATION_CAP);
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

    this.peers.set(nodeId, {
      nodeId,
      rssi,
      lastSeen: at,
      packetsHeard: (prev?.packetsHeard ?? 0) + 1,
      hops: packet.hops,
      // Only a presence packet states where the peer itself is. An incident
      // packet's coordinates are the incident's, not the sender's.
      lat: isPresence ? packet.lat : prev?.lat,
      lon: isPresence ? packet.lon : prev?.lon,
    });
  }

  private gc(): void {
    const at = this.now();

    // Peer loss is inferred from silence — no platform gives a reliable callback.
    for (const [id, peer] of this.peers) {
      if (at - peer.lastSeen > PEER_STALE_MS) this.peers.delete(id);
    }

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

  getLog(): PacketEvent[] {
    return this.log;
  }

  getRotationSize(): number {
    return this.rotation.length;
  }
}

function triageRank(t: Triage): number {
  // RED first, then YELLOW, GREEN, UNKNOWN, BLACK last.
  const order: Record<number, number> = { 0: 0, 1: 1, 2: 2, 4: 3, 3: 4 };
  return order[t] ?? 5;
}
