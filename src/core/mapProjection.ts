/**
 * Local map projection.
 *
 * WHY NOT A REAL MAP
 * ------------------
 * Every map you have ever used downloads its tiles. In the situation this app
 * is built for there is no download — no cell, no Wi-Fi, no internet — so a
 * basemap is not available at any price, and shipping the world's tiles in an
 * APK is not a thing.
 *
 * What IS available offline is the only part that matters: where every phone is
 * relative to where you are standing. A GPS receiver needs no network, and the
 * mesh already carries positions. So the map here is a true-scale local plan
 * view — north up, metres across, you at the centre — drawn from nothing but
 * the packets in hand. No streets, but correct bearing and correct distance,
 * which is what you actually walk on.
 *
 * Pure module: no react-native, no expo. Metres east/north from an origin,
 * and the arithmetic for fitting them into a viewport.
 */

import type { LatLon } from './geo';

/** Metres east (x) and north (y) of the projection origin. */
export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Metres per degree at a given latitude (WGS-84 series expansion).
 *
 * An equirectangular projection about a local origin. Its distortion grows
 * with distance from that origin, and at the scale of a BLE mesh — hundreds of
 * metres, a couple of kilometres at the outside — it is well under the GPS
 * error of the points being drawn. Simple and honest beats Mercator here.
 */
export function metersPerDegree(latDeg: number): { lat: number; lon: number } {
  const φ = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * φ) + 1.175 * Math.cos(4 * φ),
    lon: 111412.84 * Math.cos(φ) - 93.5 * Math.cos(3 * φ),
  };
}

export function project(origin: LatLon, p: LatLon): Point {
  const m = metersPerDegree(origin.lat);
  return {
    x: (p.lon - origin.lon) * m.lon,
    y: (p.lat - origin.lat) * m.lat,
  };
}

export function unproject(origin: LatLon, pt: Point): LatLon {
  const m = metersPerDegree(origin.lat);
  return {
    lat: origin.lat + pt.y / m.lat,
    lon: origin.lon + pt.x / m.lon,
  };
}

/** Compass bearing from `a` to `b`, degrees clockwise from true north. */
export function bearingDegrees(a: LatLon, b: LatLon): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dλ = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** "NE", "S" — the direction to walk, in the words people actually use. */
export function compassPoint(bearingDeg: number): string {
  return COMPASS[Math.round(((bearingDeg % 360) + 360) % 360 / 45) % 8];
}

/**
 * Bounding box of a set of points, each grown by its own radius.
 *
 * An estimated position is a circle, not a pin, so its uncertainty has to be
 * inside the box or the map would crop off the very area you are being told to
 * search.
 */
export function boundsOf(
  points: Array<Point & { radiusM?: number }>,
  minSpanM = 60
): Bounds {
  if (points.length === 0) {
    const h = minSpanM / 2;
    return { minX: -h, maxX: h, minY: -h, maxY: h };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const p of points) {
    const r = p.radiusM ?? 0;
    if (p.x - r < minX) minX = p.x - r;
    if (p.x + r > maxX) maxX = p.x + r;
    if (p.y - r < minY) minY = p.y - r;
    if (p.y + r > maxY) maxY = p.y + r;
  }

  // A single point has zero span, which would divide by zero downstream.
  const padX = Math.max(0, (minSpanM - (maxX - minX)) / 2);
  const padY = Math.max(0, (minSpanM - (maxY - minY)) / 2);

  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

export interface Fit {
  /** Screen pixels per metre. */
  pxPerM: number;
  /** Projected point that should sit at the centre of the viewport. */
  centre: Point;
}

/**
 * The zoom and centre that show everything at once.
 *
 * Clamped at the top so that two phones a metre apart do not produce a map
 * zoomed to a scale no GPS fix can justify.
 */
export function fitBounds(
  bounds: Bounds,
  viewW: number,
  viewH: number,
  padPx = 44,
  maxPxPerM = 3
): Fit {
  const spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-6, bounds.maxY - bounds.minY);
  const usableW = Math.max(1, viewW - padPx * 2);
  const usableH = Math.max(1, viewH - padPx * 2);

  return {
    pxPerM: Math.min(maxPxPerM, usableW / spanX, usableH / spanY),
    centre: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
  };
}

/**
 * Round distances a person reads without thinking.
 *
 * The range runs from a room to a subcontinent because the same map has to
 * serve both: metres when you are walking towards a phone that is ringing, and
 * hundreds of kilometres when you have zoomed out to see which state you are in.
 */
const NICE = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 25_000, 50_000, 100_000, 250_000,
  500_000, 1_000_000,
];

/** The largest round distance whose bar fits in `maxPx`. */
export function scaleBar(pxPerM: number, maxPx = 96): { meters: number; px: number } {
  let best = NICE[0];
  for (const m of NICE) {
    if (m * pxPerM <= maxPx) best = m;
  }
  return { meters: best, px: best * pxPerM };
}

/**
 * Range rings, in metres.
 *
 * Three of them, spaced so the outermost lands near the edge of what is on
 * screen. They are the only thing giving the picture a sense of distance once
 * the streets are gone.
 */
export function rangeRings(visibleRadiusM: number): number[] {
  const target = visibleRadiusM / 3;
  let step = NICE[0];
  for (const m of NICE) {
    if (m <= target) step = m;
  }
  return [step, step * 2, step * 3];
}
