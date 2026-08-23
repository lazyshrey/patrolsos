/**
 * Turning mesh state into something drawable.
 *
 * The map is not a separate source of truth — it is the same peers, estimates
 * and reports the lists already show, placed by bearing and distance instead of
 * stacked in rows. This module does that placing, and nothing else: it is pure,
 * so what the map claims can be tested without a device.
 *
 * WHAT GETS A PIN AND WHAT GETS A CIRCLE
 * --------------------------------------
 * A phone with a satellite fix is a point. A phone located only by how loudly
 * its neighbours hear it is a circle tens of metres across, and drawing it as a
 * point would send someone to the wrong side of a building with total
 * confidence. The `accuracyM` on every marker is the honest radius, and the
 * renderer is required to draw it.
 */

import type { LatLon } from './geo';
import { haversineMeters } from './geo';
import { bearingDegrees, project, type Point } from './mapProjection';
import type { LocationEstimate, Observation } from './localization';
import type { Cluster } from './deduplicator';
import type { BuzzAnswer } from './buzz';
import type { PeerState, Triage } from '../types';

export type MarkerKind = 'self' | 'direct' | 'relayed' | 'estimate' | 'incident';

export interface MapMarker {
  /** Stable across ticks, so the renderer can keep a marker's animation alive. */
  id: string;
  kind: MarkerKind;
  lat: number;
  lon: number;
  /** Metres east/north of the scene origin. */
  x: number;
  y: number;
  label: string;
  /** One line of plain language under the label in the detail sheet. */
  detail: string;
  /**
   * Radius in metres inside which the thing probably sits. Zero only for a
   * real satellite fix; the renderer draws a circle for anything above it.
   */
  accuracyM: number;
  nodeId?: number;
  triage?: Triage;
  /** Straight-line metres from this phone, or null when we have no fix. */
  distanceM: number | null;
  bearingDeg: number | null;
  hops?: number;
  battery?: number | null;
  /** Set while this phone is sounding its alarm — the renderer pulses it. */
  ringing: boolean;
  /** Wall-clock moment this was last confirmed, for the staleness fade. */
  at: number;
}

export interface MapLink {
  id: string;
  from: Point;
  to: Point;
  /** 0-1. Signal quality for a radio link; confidence for an inferred one. */
  strength: number;
  /** True when this phone is one end of the link. */
  own: boolean;
}

export interface MapScene {
  /** Everything is placed relative to this. */
  origin: LatLon | null;
  /** True when the origin is this phone's own GPS fix rather than a fallback. */
  anchoredToSelf: boolean;
  markers: MapMarker[];
  links: MapLink[];
  /** Things we know about but cannot place. Shown as a footnote, not hidden. */
  unplaced: Array<{ label: string; reason: string }>;
}

/** The engine uses (0, 0) for "no fix", and null island is not a location. */
function placed(lat?: number | null, lon?: number | null): boolean {
  return (
    lat != null &&
    lon != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    !(Math.abs(lat) < 1e-7 && Math.abs(lon) < 1e-7)
  );
}

/** An RSSI mapped onto 0-1 for line weight. -55 is loud, -95 is barely there. */
function signalStrength(rssi: number): number {
  return Math.max(0.12, Math.min(1, (rssi + 95) / 40));
}

export interface SceneInput {
  selfNodeId: number;
  fix: LatLon | null;
  peers: PeerState[];
  estimates: LocationEstimate[];
  clusters: Cluster[];
  answers: BuzzAnswer[];
  observations: Observation[];
  now?: number;
}

export function buildScene(input: SceneInput): MapScene {
  const now = input.now ?? Date.now();
  const { selfNodeId, fix, peers, estimates, clusters, answers, observations } = input;

  // A phone is "ringing" for as long as its answers keep arriving. The alarm
  // stops on its own, so this is derived from freshness rather than remembered.
  const ringing = new Set<number>();
  for (const a of answers) {
    if (now - a.at < 20_000) ringing.add(a.responderNodeId);
  }

  // --- origin -------------------------------------------------------------
  // Own fix first: a map centred on you is the one you can walk from. Without
  // one, fall back to the middle of everything we can place, so the picture is
  // still useful — it just cannot say where *you* are.
  const candidates: LatLon[] = [];
  for (const p of peers) {
    if (placed(p.lat, p.lon)) candidates.push({ lat: p.lat!, lon: p.lon! });
  }
  for (const e of estimates) candidates.push({ lat: e.lat, lon: e.lon });
  for (const c of clusters) {
    if (placed(c.lat, c.lon)) candidates.push({ lat: c.lat, lon: c.lon });
  }

  let origin: LatLon | null = fix;
  if (!origin && candidates.length > 0) {
    origin = {
      lat: candidates.reduce((n, c) => n + c.lat, 0) / candidates.length,
      lon: candidates.reduce((n, c) => n + c.lon, 0) / candidates.length,
    };
  }

  if (!origin) {
    return {
      origin: null,
      anchoredToSelf: false,
      markers: [],
      links: [],
      unplaced: unplacedOf(peers, clusters, fix),
    };
  }

  const anchor = origin;
  const at = (p: LatLon) => project(anchor, p);
  const from = (p: LatLon) =>
    fix ? { d: haversineMeters(fix, p), b: bearingDegrees(fix, p) } : { d: null, b: null };

  const markers: MapMarker[] = [];
  const byNode = new Map<number, Point>();

  // --- this phone ---------------------------------------------------------
  if (fix) {
    const pt = at(fix);
    byNode.set(selfNodeId, pt);
    markers.push({
      id: 'self',
      kind: 'self',
      lat: fix.lat,
      lon: fix.lon,
      x: pt.x,
      y: pt.y,
      label: 'You',
      detail: 'This phone, from its own satellite fix.',
      accuracyM: 0,
      nodeId: selfNodeId,
      distanceM: 0,
      bearingDeg: null,
      hops: 0,
      ringing: false,
      at: now,
    });
  }

  // --- phones that told us where they are ---------------------------------
  const positioned = new Set<number>();
  for (const p of peers) {
    if (!placed(p.lat, p.lon)) continue;
    const ll = { lat: p.lat!, lon: p.lon! };
    const pt = at(ll);
    const rel = from(ll);
    positioned.add(p.nodeId);
    byNode.set(p.nodeId, pt);
    markers.push({
      id: `peer:${p.nodeId}`,
      kind: p.hops === 0 ? 'direct' : 'relayed',
      lat: ll.lat,
      lon: ll.lon,
      x: pt.x,
      y: pt.y,
      label: `Node ${p.nodeId}`,
      detail:
        p.hops === 0
          ? 'Heard directly off the radio.'
          : `Reached through ${p.hops} phone${p.hops === 1 ? '' : 's'}.`,
      accuracyM: 0,
      nodeId: p.nodeId,
      distanceM: rel.d,
      bearingDeg: rel.b,
      hops: p.hops,
      battery: p.battery ?? null,
      ringing: ringing.has(p.nodeId) || (p.ringingUntil != null && p.ringingUntil > now),
      at: p.lastSeen,
    });
  }

  // --- phones with no fix, placed by the phones that can hear them ---------
  for (const e of estimates) {
    if (positioned.has(e.targetNodeId)) continue; // a real fix always wins
    const ll = { lat: e.lat, lon: e.lon };
    const pt = at(ll);
    const rel = from(ll);
    byNode.set(e.targetNodeId, pt);
    markers.push({
      id: `est:${e.targetNodeId}`,
      kind: 'estimate',
      lat: e.lat,
      lon: e.lon,
      x: pt.x,
      y: pt.y,
      label: `Node ${e.targetNodeId}`,
      detail:
        e.method === 'trilateration'
          ? `No satellite fix. Placed by ${e.observerCount} phones that can hear it.`
          : 'No satellite fix. Roughly placed from the one phone hearing it best.',
      accuracyM: Math.max(8, e.uncertaintyM),
      nodeId: e.targetNodeId,
      distanceM: rel.d,
      bearingDeg: rel.b,
      ringing: ringing.has(e.targetNodeId),
      at: now,
    });
  }

  // --- reports ------------------------------------------------------------
  for (const c of clusters) {
    if (!placed(c.lat, c.lon)) continue;
    const ll = { lat: c.lat, lon: c.lon };
    const pt = at(ll);
    const rel = from(ll);
    markers.push({
      id: `inc:${c.id}`,
      kind: 'incident',
      lat: c.lat,
      lon: c.lon,
      x: pt.x,
      y: pt.y,
      label: c.mine ? 'Your report' : 'Report',
      detail: c.reportCount > 1 ? `${c.reportCount} people reported this.` : 'One report.',
      accuracyM: 0,
      triage: c.triage,
      distanceM: rel.d,
      bearingDeg: rel.b,
      hops: c.minHops,
      ringing: false,
      at: c.lastSeen,
    });
  }

  // --- the links between them --------------------------------------------
  // Two sources, drawn the same way because they mean the same thing: these two
  // phones can hear each other, so a packet can cross here. This is the part
  // the lists cannot show — a network has a shape.
  const links: MapLink[] = [];
  const drawn = new Set<string>();

  const addLink = (a: number, b: number, strength: number) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (drawn.has(key)) return;
    const pa = byNode.get(a);
    const pb = byNode.get(b);
    if (!pa || !pb) return;
    drawn.add(key);
    links.push({
      id: key,
      from: pa,
      to: pb,
      strength,
      own: a === selfNodeId || b === selfNodeId,
    });
  };

  for (const p of peers) {
    if (p.hops === 0) addLink(selfNodeId, p.nodeId, signalStrength(p.rssi));
  }
  for (const o of observations) {
    addLink(o.observerNodeId, o.targetNodeId, signalStrength(o.rssi));
  }

  return {
    origin,
    anchoredToSelf: fix != null,
    markers,
    links,
    unplaced: unplacedOf(peers, clusters, fix),
  };
}

function unplacedOf(
  peers: PeerState[],
  clusters: Cluster[],
  fix: LatLon | null
): MapScene['unplaced'] {
  const out: MapScene['unplaced'] = [];
  if (!fix) {
    out.push({ label: 'You', reason: 'no satellite fix on this phone yet' });
  }
  const blind = peers.filter((p) => !placed(p.lat, p.lon)).length;
  if (blind > 0) {
    out.push({
      label: `${blind} phone${blind === 1 ? '' : 's'}`,
      reason: 'heard, but has not shared a position',
    });
  }
  const loose = clusters.filter((c) => !placed(c.lat, c.lon)).length;
  if (loose > 0) {
    out.push({
      label: `${loose} report${loose === 1 ? '' : 's'}`,
      reason: 'sent by a phone with no fix',
    });
  }
  return out;
}
