import {
  MIN_OBSERVERS,
  PATH_LOSS_EXPONENT,
  TX_POWER_AT_1M,
  estimateError,
  estimateLocation,
  rssiToDistanceM,
  type Observation,
} from '../src/core/localization';
import type { LatLon } from '../src/core/geo';

/** Inverse of the path-loss model, so we can synthesise a realistic reading. */
function distanceToRssi(d: number): number {
  return TX_POWER_AT_1M - 10 * PATH_LOSS_EXPONENT * Math.log10(Math.max(d, 1));
}

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

function offsetMetres(origin: LatLon, dx: number, dy: number): LatLon {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    lat: origin.lat + dy / M_PER_DEG_LAT,
    lon: origin.lon + dx / (M_PER_DEG_LON * Math.cos(latRad)),
  };
}

function observe(
  observerNodeId: number,
  observer: LatLon,
  truth: LatLon,
  noiseDb = 0
): Observation {
  const d = Math.hypot(
    (truth.lon - observer.lon) * M_PER_DEG_LON * Math.cos((observer.lat * Math.PI) / 180),
    (truth.lat - observer.lat) * M_PER_DEG_LAT
  );
  return {
    observerNodeId,
    observer,
    targetNodeId: 99,
    rssi: distanceToRssi(d) + noiseDb,
    at: 1000,
  };
}

describe('rssiToDistanceM', () => {
  it('is monotonic below the reference power — weaker means further', () => {
    let prev = 0;
    for (let rssi = TX_POWER_AT_1M - 1; rssi >= -100; rssi -= 5) {
      const d = rssiToDistanceM(rssi);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it('clamps to 1 m at or above the reference power', () => {
    // You cannot be nearer than the distance the model is calibrated at, so a
    // very strong signal must saturate rather than imply a sub-metre fix.
    for (const rssi of [TX_POWER_AT_1M, -50, -40, -20]) {
      expect(rssiToDistanceM(rssi)).toBe(1);
    }
  });

  it('reads about 1 m at the reference power', () => {
    expect(rssiToDistanceM(TX_POWER_AT_1M)).toBeCloseTo(1, 1);
  });

  it('never returns zero, negative or infinite', () => {
    for (const rssi of [-10, -59, -100, -140]) {
      const d = rssiToDistanceM(rssi);
      expect(d).toBeGreaterThan(0);
      expect(Number.isFinite(d)).toBe(true);
    }
  });
});

describe('estimateLocation', () => {
  const origin: LatLon = { lat: 28.6139, lon: 77.209 };

  it('recovers a known position from three clean observers', () => {
    // Target 30 m east, 20 m north of origin.
    const truth = offsetMetres(origin, 30, 20);
    const obs = [
      observe(1, origin, truth),
      observe(2, offsetMetres(origin, 80, 0), truth),
      observe(3, offsetMetres(origin, 0, 80), truth),
    ];

    const est = estimateLocation(99, obs)!;
    expect(est.method).toBe('trilateration');
    expect(est.observerCount).toBe(3);
    // Noise-free, so this should be tight.
    expect(estimateError(est, truth)).toBeLessThan(5);
  });

  it('degrades gracefully with realistic RSSI noise', () => {
    const truth = offsetMetres(origin, 40, 25);
    const noise = [4, -5, 3, -3];
    const obs = [
      observe(1, origin, truth, noise[0]),
      observe(2, offsetMetres(origin, 90, 0), truth, noise[1]),
      observe(3, offsetMetres(origin, 0, 90), truth, noise[2]),
      observe(4, offsetMetres(origin, 90, 90), truth, noise[3]),
    ];

    const est = estimateLocation(99, obs)!;
    // Tens of metres is the honest expectation, and that is still useful:
    // it narrows a search to a building rather than a district.
    expect(estimateError(est, truth)).toBeLessThan(60);
    expect(est.uncertaintyM).toBeGreaterThanOrEqual(15);
  });

  it('never reports an uncertainty tighter than RSSI can support', () => {
    const truth = offsetMetres(origin, 10, 10);
    const obs = [
      observe(1, origin, truth),
      observe(2, offsetMetres(origin, 60, 0), truth),
      observe(3, offsetMetres(origin, 0, 60), truth),
    ];
    expect(estimateLocation(99, obs)!.uncertaintyM).toBeGreaterThanOrEqual(15);
  });

  it('falls back to the nearest observer with too few readings', () => {
    const truth = offsetMetres(origin, 20, 0);
    const est = estimateLocation(99, [observe(1, origin, truth)])!;
    expect(est.method).toBe('nearest-observer');
    expect(est.observerCount).toBeLessThan(MIN_OBSERVERS);
    // Uncertainty must cover the distance implied by the signal.
    expect(est.uncertaintyM).toBeGreaterThanOrEqual(20);
  });

  it('handles collinear observers without producing nonsense', () => {
    const truth = offsetMetres(origin, 30, 40);
    const obs = [
      observe(1, origin, truth),
      observe(2, offsetMetres(origin, 50, 0), truth),
      observe(3, offsetMetres(origin, 100, 0), truth),
    ];

    const est = estimateLocation(99, obs)!;
    expect(Number.isFinite(est.lat)).toBe(true);
    expect(Number.isFinite(est.lon)).toBe(true);
    expect(est.uncertaintyM).toBeGreaterThan(0);
  });

  it('returns null when nobody heard the target', () => {
    expect(estimateLocation(99, [])).toBeNull();
    const otherTarget: Observation = { ...observe(1, origin, origin), targetNodeId: 7 };
    expect(estimateLocation(99, [otherTarget])).toBeNull();
  });

  it('keeps only the freshest reading per observer', () => {
    const truth = offsetMetres(origin, 30, 20);
    const stale = { ...observe(1, origin, truth), at: 1, rssi: -95 };
    const fresh = { ...observe(1, origin, truth), at: 9999 };

    const est = estimateLocation(99, [
      stale,
      fresh,
      observe(2, offsetMetres(origin, 80, 0), truth),
      observe(3, offsetMetres(origin, 0, 80), truth),
    ])!;

    expect(est.observerCount).toBe(3); // not 4 — observer 1 counted once
    expect(estimateError(est, truth)).toBeLessThan(10);
  });

  it('all observers at one point cannot pin a position', () => {
    const truth = offsetMetres(origin, 25, 25);
    const obs = [observe(1, origin, truth), observe(2, origin, truth), observe(3, origin, truth)];
    const est = estimateLocation(99, obs)!;
    expect(est.method).toBe('nearest-observer');
  });
});
