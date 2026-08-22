/**
 * Geo-semantic deduplication.
 *
 * Six people reporting the same collapsed building must show as ONE incident
 * with six confirmations, not six incidents.
 *
 * Fuzzy text matching on panic-typed descriptions is unreliable, and the wire
 * format carries a preset index rather than free text, so the test is
 * deterministic instead:
 *
 *   same category  AND  within 150 m  AND  within 15 minutes
 *
 * Candidates come from a geohash-6 bucket (~1.2 km) plus its 8 neighbours —
 * without the neighbours, two reports 20 m apart either side of a cell edge
 * would never be compared.
 */

import type { Incident, Status, Triage } from '../types';
import { geohashCellAndNeighbors, geohashEncode, haversineMeters, weightedCentroid } from './geo';

export const MERGE_RADIUS_M = 150;
export const MERGE_WINDOW_MS = 15 * 60 * 1000;
const GEOHASH_PRECISION = 6;

export interface Cluster {
  /** packetId of the earliest member — stable identity for the cluster. */
  id: number;
  lat: number;
  lon: number;
  category: Incident['category'];
  /** Most severe member. Never averages severity downward. */
  triage: Triage;
  /** Max, not sum — it is one event reported several times. */
  casualties: number;
  status: Status;
  firstSeen: number;
  lastSeen: number;
  minHops: number;
  reportCount: number;
  mine: boolean;
  members: Incident[];
}

/** RED < YELLOW < GREEN < UNKNOWN < BLACK, by urgency. */
function severityRank(t: Triage): number {
  const order: Record<number, number> = { 0: 0, 1: 1, 2: 2, 4: 3, 3: 4 };
  return order[t] ?? 5;
}

function shouldMerge(a: Incident, b: Incident): boolean {
  if (a.category !== b.category) return false;
  if (Math.abs(a.firstSeen - b.firstSeen) > MERGE_WINDOW_MS) return false;
  return haversineMeters(a, b) <= MERGE_RADIUS_M;
}

export function clusterIncidents(incidents: Incident[]): Cluster[] {
  // Bucket by geohash so we only compare plausible neighbours.
  const buckets = new Map<string, Incident[]>();
  for (const inc of incidents) {
    const cell = geohashEncode(inc.lat, inc.lon, GEOHASH_PRECISION);
    const list = buckets.get(cell);
    if (list) list.push(inc);
    else buckets.set(cell, [inc]);
  }

  const assigned = new Map<number, number>(); // packetId -> cluster index
  const groups: Incident[][] = [];

  // Oldest first, so the earliest report anchors the cluster identity.
  const ordered = [...incidents].sort((a, b) => a.firstSeen - b.firstSeen);

  for (const inc of ordered) {
    if (assigned.has(inc.packetId)) continue;

    const group = [inc];
    assigned.set(inc.packetId, groups.length);

    const candidates: Incident[] = [];
    for (const cell of geohashCellAndNeighbors(inc.lat, inc.lon, GEOHASH_PRECISION)) {
      const list = buckets.get(cell);
      if (list) candidates.push(...list);
    }

    for (const other of candidates) {
      if (assigned.has(other.packetId)) continue;
      if (shouldMerge(inc, other)) {
        group.push(other);
        assigned.set(other.packetId, groups.length);
      }
    }

    groups.push(group);
  }

  return groups.map(toCluster).sort(
    (a, b) => severityRank(a.triage) - severityRank(b.triage) || b.lastSeen - a.lastSeen
  );
}

function toCluster(members: Incident[]): Cluster {
  const anchor = members.reduce((a, b) => (a.firstSeen <= b.firstSeen ? a : b));

  const centre = weightedCentroid(
    members.map((m) => ({ lat: m.lat, lon: m.lon })),
    members.map((m) => m.casualties)
  );

  return {
    id: anchor.packetId,
    lat: centre.lat,
    lon: centre.lon,
    category: anchor.category,
    triage: members.reduce(
      (worst, m) => (severityRank(m.triage) < severityRank(worst) ? m.triage : worst),
      members[0].triage
    ),
    casualties: members.reduce((max, m) => Math.max(max, m.casualties), 0),
    status: members.reduce<number>((max, m) => Math.max(max, m.status), 0) as Status,
    firstSeen: Math.min(...members.map((m) => m.firstSeen)),
    lastSeen: Math.max(...members.map((m) => m.lastSeen)),
    minHops: Math.min(...members.map((m) => m.hops)),
    reportCount: members.length,
    mine: members.some((m) => m.mine),
    members,
  };
}
