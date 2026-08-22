/**
 * Conflict resolution.
 *
 * Two different mechanisms, deliberately:
 *
 *  1. STATUS is a totally-ordered monotonic lattice — merge is max(). This is
 *     conflict-free by construction, needs no clock, and guarantees a resolved
 *     incident can never regress to reported whatever order packets arrive in.
 *
 *  2. Mutable value fields (casualties, triage, descPreset) use a Lamport
 *     last-writer-wins register, tiebroken on originNodeId so every node picks
 *     the same winner.
 *
 * ttl/hops are transport metadata and are never merged — they always come from
 * the packet just received.
 */

import type { Incident, Packet, Status } from '../types';

export function mergeStatus(a: Status, b: Status): Status {
  return Math.max(a, b) as Status;
}

/** True when `remote` should win the LWW register. */
export function remoteWins(
  localLamport: number,
  localNode: number,
  remoteLamport: number,
  remoteNode: number
): boolean {
  if (remoteLamport !== localLamport) return remoteLamport > localLamport;
  return remoteNode > localNode;
}

export function nextLamport(localClock: number, seenMax: number): number {
  return (Math.max(localClock, seenMax) + 1) & 0xffff;
}

export function incidentFromPacket(p: Packet, now: number, mine: boolean): Incident {
  return {
    packetId: p.packetId,
    lat: p.lat,
    lon: p.lon,
    category: p.category,
    triage: p.triage,
    casualties: p.casualties,
    status: p.status,
    lamport: p.lamport,
    descPreset: p.descPreset,
    originNodeId: p.originNodeId,
    firstSeen: now,
    lastSeen: now,
    hops: p.hops,
    reportCount: 1,
    mine,
  };
}

export function mergeIncident(local: Incident, p: Packet, now: number): Incident {
  const takeRemote = remoteWins(
    local.lamport,
    local.originNodeId,
    p.lamport,
    p.originNodeId
  );

  return {
    ...local,
    // Lattice — always advances, never regresses.
    status: mergeStatus(local.status, p.status),
    // LWW register.
    casualties: takeRemote ? p.casualties : local.casualties,
    triage: takeRemote ? p.triage : local.triage,
    descPreset: takeRemote ? p.descPreset : local.descPreset,
    lamport: Math.max(local.lamport, p.lamport),
    // Transport metadata — always from the freshest packet.
    hops: p.hops,
    lastSeen: now,
  };
}
