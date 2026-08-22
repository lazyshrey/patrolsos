/** Geospatial primitives. Pure functions, no dependencies. */

const R_EARTH_M = 6_371_000;
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'; // geohash alphabet (no a,i,l,o)

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversineMeters(a: LatLon, b: LatLon): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const dφ = φ2 - φ1;
  const dλ = ((b.lon - a.lon) * Math.PI) / 180;

  const h =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function geohashEncode(lat: number, lon: number, precision = 6): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;

  let hash = '';
  let bits = 0;
  let bit = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        bits = (bits << 1) | 1;
        lonMin = mid;
      } else {
        bits = bits << 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bits = (bits << 1) | 1;
        latMin = mid;
      } else {
        bits = bits << 1;
        latMax = mid;
      }
    }
    even = !even;

    if (++bit === 5) {
      hash += BASE32[bits];
      bits = 0;
      bit = 0;
    }
  }
  return hash;
}

export function geohashDecode(hash: string): { lat: number; lon: number; latErr: number; lonErr: number } {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let even = true;

  for (const ch of hash) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1;
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (bit) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid;
        else latMax = mid;
      }
      even = !even;
    }
  }

  return {
    lat: (latMin + latMax) / 2,
    lon: (lonMin + lonMax) / 2,
    latErr: (latMax - latMin) / 2,
    lonErr: (lonMax - lonMin) / 2,
  };
}

/**
 * The 8 surrounding cells.
 *
 * REQUIRED for correct clustering: two reports 20 m apart that straddle a cell
 * boundary would otherwise never be compared and would never merge.
 */
export function geohashNeighbors(hash: string): string[] {
  const { lat, lon, latErr, lonErr } = geohashDecode(hash);
  const p = hash.length;
  const out: string[] = [];

  for (const dLat of [-1, 0, 1]) {
    for (const dLon of [-1, 0, 1]) {
      if (dLat === 0 && dLon === 0) continue;
      const nLat = clampLat(lat + dLat * latErr * 2);
      const nLon = wrapLon(lon + dLon * lonErr * 2);
      out.push(geohashEncode(nLat, nLon, p));
    }
  }
  return [...new Set(out)];
}

/** Cell and its neighbours — the full candidate set for a merge test. */
export function geohashCellAndNeighbors(lat: number, lon: number, precision = 6): string[] {
  const cell = geohashEncode(lat, lon, precision);
  return [cell, ...geohashNeighbors(cell)];
}

export function weightedCentroid(points: LatLon[], weights: number[]): LatLon {
  let totalW = 0;
  let lat = 0;
  let lon = 0;
  for (let i = 0; i < points.length; i++) {
    const w = Math.max(weights[i] ?? 1, 1);
    lat += points[i].lat * w;
    lon += points[i].lon * w;
    totalW += w;
  }
  if (totalW === 0) return points[0] ?? { lat: 0, lon: 0 };
  return { lat: lat / totalW, lon: lon / totalW };
}

function clampLat(v: number): number {
  return Math.min(90, Math.max(-90, v));
}

function wrapLon(v: number): number {
  let x = v;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}
