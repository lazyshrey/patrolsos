/**
 * Outbox — the queue of packets THIS node authored.
 *
 * Broadcasting into an advertisement is fire-and-forget: there is no ACK, no
 * connection, nobody to tell you it arrived. So "did my report get out?" — the
 * one question a frightened person actually has — needs answering some other
 * way.
 *
 * ECHO-BASED DELIVERY CONFIRMATION
 * -------------------------------
 * When a peer relays our packet, it re-broadcasts it with hops incremented. We
 * hear that. A packet carrying OUR originNodeId with hops > 0 is proof that at
 * least one other device received it and chose to carry it onward. That is a
 * genuine delivery receipt, obtained for free, with no protocol addition.
 *
 * It proves "someone picked this up", NOT "help is coming" — the UI must not
 * overstate it.
 *
 * The queue also survives the radio being off, the app being backgrounded, and
 * there being nobody in range: entries stay pending and keep their place in the
 * broadcast rotation until they are echoed or they expire.
 */

import type { Packet } from '../types';

/** Stop re-broadcasting an unacknowledged packet after this long. */
export const OUTBOX_TTL_MS = 60 * 60 * 1000;

/** Cap so a node that reports constantly cannot exhaust storage. */
export const OUTBOX_CAP = 200;

export type OutboxState = 'pending' | 'delivered' | 'expired';

export interface OutboxEntry {
  packetId: number;
  packet: Packet;
  createdAt: number;
  /** Times we have heard someone else relay this packet. */
  echoes: number;
  /** When the first echo arrived — the moment we knew it got out. */
  firstEchoAt: number | null;
  lastBroadcastAt: number;
  state: OutboxState;
}

export class Outbox {
  private entries = new Map<number, OutboxEntry>();

  constructor(private now: () => number = () => Date.now()) {}

  /** Record a packet we authored. Idempotent on packetId. */
  add(packet: Packet): OutboxEntry {
    const at = this.now();
    const existing = this.entries.get(packet.packetId);
    if (existing) {
      // A status update reuses the packetId — refresh the payload, keep history.
      existing.packet = packet;
      existing.lastBroadcastAt = at;
      return existing;
    }

    const entry: OutboxEntry = {
      packetId: packet.packetId,
      packet,
      createdAt: at,
      echoes: 0,
      firstEchoAt: null,
      lastBroadcastAt: at,
      state: 'pending',
    };
    this.entries.set(packet.packetId, entry);
    this.evictIfNeeded();
    return entry;
  }

  /**
   * Called for every inbound packet whose originNodeId is ours and whose hops
   * are above zero. Returns true if this was a real delivery receipt.
   */
  noteEcho(packetId: number): boolean {
    const entry = this.entries.get(packetId);
    if (!entry) return false;

    entry.echoes++;
    if (entry.firstEchoAt === null) {
      entry.firstEchoAt = this.now();
      entry.state = 'delivered';
      return true;
    }
    return false;
  }

  markBroadcast(packetId: number): void {
    const entry = this.entries.get(packetId);
    if (entry) entry.lastBroadcastAt = this.now();
  }

  /**
   * Packets still worth spending radio time on: never echoed, not yet expired.
   * Oldest first — a report that has been waiting longest is the most urgent to
   * get out.
   */
  pending(): OutboxEntry[] {
    const at = this.now();
    return [...this.entries.values()]
      .filter((e) => e.state === 'pending' && at - e.createdAt < OUTBOX_TTL_MS)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  all(): OutboxEntry[] {
    return [...this.entries.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(packetId: number): OutboxEntry | undefined {
    return this.entries.get(packetId);
  }

  /** Marks anything past its TTL as expired. Returns how many changed. */
  sweep(): number {
    const at = this.now();
    let changed = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === 'pending' && at - entry.createdAt >= OUTBOX_TTL_MS) {
        entry.state = 'expired';
        changed++;
      }
    }
    return changed;
  }

  stats(): { pending: number; delivered: number; expired: number } {
    let pending = 0;
    let delivered = 0;
    let expired = 0;
    for (const e of this.entries.values()) {
      if (e.state === 'pending') pending++;
      else if (e.state === 'delivered') delivered++;
      else expired++;
    }
    return { pending, delivered, expired };
  }

  /** Restore from persistence. */
  load(entries: OutboxEntry[]): void {
    for (const e of entries) this.entries.set(e.packetId, e);
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= OUTBOX_CAP) return;
    // Drop the oldest resolved entries first; never drop something still pending.
    const resolved = [...this.entries.values()]
      .filter((e) => e.state !== 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const e of resolved) {
      if (this.entries.size <= OUTBOX_CAP) break;
      this.entries.delete(e.packetId);
    }

    if (this.entries.size > OUTBOX_CAP) {
      const oldest = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
      for (const e of oldest) {
        if (this.entries.size <= OUTBOX_CAP) break;
        this.entries.delete(e.packetId);
      }
    }
  }
}
