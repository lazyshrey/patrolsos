/**
 * Locating a phone that has no GPS fix.
 *
 * The people most in need are often the hardest to locate: trapped under
 * rubble, in a basement, in a stairwell — exactly the places a GPS fix never
 * arrives. But their phone is still shouting a BLE advertisement, and every
 * phone that hears it records a signal strength.
 *
 * Three phones that CAN see the sky, each hearing the same silent phone, are
 * enough to estimate where it is.
 *
 *   RSSI -> distance   log-distance path loss model
 *   3+ distances       -> trilateration by linear least squares
 *   residuals          -> an honest uncertainty radius
 *
 * ACCURACY, STATED HONESTLY
 * -------------------------
 * RSSI ranging is noisy. Walls, bodies, orientation and chipset variation all
 * move it. Expect tens of metres, not metres, and worse indoors — which is
 * precisely where this gets used. So this NEVER produces a pin: it produces a
 * centre and a radius, and the UI must render the circle, not the point.
 *
 * It narrows a search from "somewhere in this district" to "somewhere in this
 * building". That is the whole claim, and it is worth making.
 */

import type { LatLon } from './geo';
import { haversineMeters } from './geo';

/**
 * Reference RSSI at 1 metre for BLE at ADVERTISE_TX_POWER_HIGH.
 * Chipset-dependent; -59 dBm is the common empirical value.
 */
export const TX_POWER_AT_1M = -59;

/**
 * Path-loss exponent. 2.0 is free space; indoors with walls and bodies runs
 * 2.5-4. We use 2.7 as a disaster-realistic middle: rubble and crowds, not a
 * clear field.
 */
export const PATH_LOSS_EXPONENT = 2.7;

/** Below this many observers, trilateration is not meaningfully constrained. */
export const MIN_OBSERVERS = 3;

/** Ranging beyond this is too noisy to be worth including. */
export const MAX_USEFUL_RANGE_M = 120;

export interface Observation {
  /** Who heard it. */
  observerNodeId: number;
  /** Where the observer was standing — must be a real GPS fix. */
  observer: LatLon;
  /** Who was heard. */
  targetNodeId: number;
  rssi: number;
  at: number;
}

export interface LocationEstimate {
  targetNodeId: number;
  lat: number;
  lon: number;
  /** Radius in metres inside which the target probably sits. Never zero. */
  uncertaintyM: number;
  observerCount: number;
  /** 'estimated' is the only honest word for this. Never call it a fix. */
  method: 'trilateration' | 'nearest-observer';
}

// ---------------------------------------------------------------------------
// Ranging
// ---------------------------------------------------------------------------

export function rssiToDistanceM(
  rssi: number,
  txPowerAt1m = TX_POWER_AT_1M,
  n = PATH_LOSS_EXPONENT
): number {
  if (rssi >= txPowerAt1m) return 1;
  const d = Math.pow(10, (txPowerAt1m - rssi) / (10 * n));
  return Math.min(d, MAX_USEFUL_RANGE_M * 2);
}

// ---------------------------------------------------------------------------
// Local planar projection
//
// Trilateration is far easier in metres than in degrees. Over the hundreds of
// metres a BLE mesh spans, an equirectangular projection about a local origin
// is accurate to well under the noise floor of RSSI ranging.
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

function toLocal(p: LatLon, origin: LatLon): { x: number; y: number } {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    x: (p.lon - origin.lon) * M_PER_DEG_LON * Math.cos(latRad),
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

function toLatLon(x: number, y: number, origin: LatLon): LatLon {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    lat: origin.lat + y / M_PER_DEG_LAT,
    lon: origin.lon + x / (M_PER_DEG_LON * Math.cos(latRad)),
  };
}

// ---------------------------------------------------------------------------
// Trilateration
// ---------------------------------------------------------------------------

/**
 * Estimate where `targetNodeId` is, from observations of it.
 *
 * Returns null when there is nothing useful to say — that is a feature. A
 * confidently wrong position sends a rescue team to the wrong building.
 */
export function estimateLocation(
  targetNodeId: number,
  observations: Observation[]
): LocationEstimate | null {
  const obs = dedupeByObserver(observations.filter((o) => o.targetNodeId === targetNodeId));
  if (obs.length === 0) return null;

  const origin = obs[0].observer;

  // Fallback: one or two observers cannot constrain a position, but "within
  // radio range of a phone at this spot" is still real information.
  if (obs.length < MIN_OBSERVERS) {
    const best = obs.reduce((a, b) => (a.rssi > b.rssi ? a : b));
    return {
      targetNodeId,
      lat: best.observer.lat,
      lon: best.observer.lon,
      uncertaintyM: Math.max(rssiToDistanceM(best.rssi), 25),
      observerCount: obs.length,
      method: 'nearest-observer',
    };
  }

  const anchors = obs.map((o) => {
    const local = toLocal(o.observer, origin);
    return { ...local, d: rssiToDistanceM(o.rssi) };
  });

  const solved = solveLinear(anchors);
  if (!solved) {
    // Degenerate geometry — collinear observers, or all at the same spot.
    const best = obs.reduce((a, b) => (a.rssi > b.rssi ? a : b));
    return {
      targetNodeId,
      lat: best.observer.lat,
      lon: best.observer.lon,
      uncertaintyM: Math.max(rssiToDistanceM(best.rssi), 40),
      observerCount: obs.length,
      method: 'nearest-observer',
    };
  }

  const { lat, lon } = toLatLon(solved.x, solved.y, origin);

  // Uncertainty is the RMS disagreement between measured and implied ranges.
  // It is an honest number: bad geometry and noisy RSSI both inflate it.
  let sumSq = 0;
  for (const a of anchors) {
    const implied = Math.hypot(solved.x - a.x, solved.y - a.y);
    sumSq += (implied - a.d) ** 2;
  }
  const rms = Math.sqrt(sumSq / anchors.length);

  return {
    targetNodeId,
    lat,
    lon,
    // Floor of 15 m: RSSI ranging is never better than that, and a tight
    // circle would imply a precision we do not have.
    uncertaintyM: Math.max(15, Math.round(rms)),
    observerCount: anchors.length,
    method: 'trilateration',
  };
}

/**
 * Linear least squares. Subtracting the first anchor's circle equation from
 * every other one eliminates the quadratic term, leaving a linear system.
 */
function solveLinear(
  anchors: Array<{ x: number; y: number; d: number }>
): { x: number; y: number } | null {
  const [a0, ...rest] = anchors;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxb = 0;
  let syb = 0;

  for (const a of rest) {
    const ax = 2 * (a.x - a0.x);
    const ay = 2 * (a.y - a0.y);
    const b =
      a0.d ** 2 - a.d ** 2 + (a.x ** 2 - a0.x ** 2) + (a.y ** 2 - a0.y ** 2);

    sxx += ax * ax;
    sxy += ax * ay;
    syy += ay * ay;
    sxb += ax * b;
    syb += ay * b;
  }

  const det = sxx * syy - sxy * sxy;
  // Near-zero determinant means the observers are collinear or coincident:
  // the system does not pin down a point.
  if (!Number.isFinite(det) || Math.abs(det) < 1e-6) return null;

  const x = (syy * sxb - sxy * syb) / det;
  const y = (sxx * syb - sxy * sxb) / det;

  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Keep only each observer's strongest, most recent reading. */
function dedupeByObserver(obs: Observation[]): Observation[] {
  const best = new Map<number, Observation>();
  for (const o of obs) {
    const prev = best.get(o.observerNodeId);
    if (!prev || o.at > prev.at || (o.at === prev.at && o.rssi > prev.rssi)) {
      best.set(o.observerNodeId, o);
    }
  }
  return [...best.values()];
}

/**
 * How close a peer is, in words rather than false precision.
 *
 * Two GPS fixes each accurate to ±5-10 m can put two phones lying side by side
 * "9 m" apart — the number is arithmetically correct and completely wrong. At
 * short range RSSI is the better instrument, so we use it, and we report a band
 * rather than a figure because that is genuinely all either instrument knows.
 *
 * A metre figure only appears once the GPS separation is large enough to
 * survive the combined error of both fixes.
 */
export const GPS_TRUST_THRESHOLD_M = 40;

export type Proximity =
  | 'right here'
  | 'very close'
  | 'nearby'
  | 'in range'
  | 'far'
  | 'relayed';

export function describeProximity(opts: {
  hops: number;
  rssi: number;
  gpsDistanceM?: number | null;
}): { label: Proximity; detail: string } {
  if (opts.hops > 0) {
    return { label: 'relayed', detail: 'through another phone' };
  }

  // Far enough apart that GPS beats RSSI and the number means something.
  if (opts.gpsDistanceM != null && opts.gpsDistanceM > GPS_TRUST_THRESHOLD_M) {
    return {
      label: 'far',
      detail:
        opts.gpsDistanceM < 1000
          ? `${Math.round(opts.gpsDistanceM / 10) * 10} m away`
          : `${(opts.gpsDistanceM / 1000).toFixed(1)} km away`,
    };
  }

  if (opts.rssi >= -55) return { label: 'right here', detail: 'right here' };
  if (opts.rssi >= -68) return { label: 'very close', detail: 'a few steps away' };
  if (opts.rssi >= -80) return { label: 'nearby', detail: 'nearby' };
  return { label: 'in range', detail: 'at the edge of range' };
}

/** How far off an estimate turned out to be. For tests and calibration. */
export function estimateError(estimate: LocationEstimate, truth: LatLon): number {
  return haversineMeters({ lat: estimate.lat, lon: estimate.lon }, truth);
}
