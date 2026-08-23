import { haversineMeters } from '../src/core/geo';
import {
  bearingDegrees,
  boundsOf,
  compassPoint,
  fitBounds,
  project,
  rangeRings,
  scaleBar,
  unproject,
} from '../src/core/mapProjection';

const DELHI = { lat: 28.6139, lon: 77.209 };

describe('local projection', () => {
  it('round-trips a point back to where it started', () => {
    const p = { lat: 28.6165, lon: 77.2121 };
    const back = unproject(DELHI, project(DELHI, p));
    expect(back.lat).toBeCloseTo(p.lat, 9);
    expect(back.lon).toBeCloseTo(p.lon, 9);
  });

  it('agrees with haversine over mesh-sized distances', () => {
    // The map is only ever asked to draw hundreds of metres, so the flat-earth
    // approximation has to be indistinguishable from the real thing there.
    // The residual is a few metres per kilometre — it is the ellipsoid-vs-sphere
    // difference between the two formulas more than projection error, and it
    // sits an order of magnitude under the GPS noise on every point drawn.
    for (const p of [
      { lat: 28.6148, lon: 77.209 }, // ~100 m north
      { lat: 28.6139, lon: 77.2192 }, // ~1 km east
      { lat: 28.6049, lon: 77.1999 }, // ~1.3 km south-west
    ]) {
      const pt = project(DELHI, p);
      const flat = Math.hypot(pt.x, pt.y);
      const real = haversineMeters(DELHI, p);
      expect(Math.abs(flat - real)).toBeLessThan(Math.max(0.5, real * 0.003));
    }
  });

  it('puts north up and east right', () => {
    expect(project(DELHI, { lat: DELHI.lat + 0.001, lon: DELHI.lon }).y).toBeGreaterThan(0);
    expect(project(DELHI, { lat: DELHI.lat, lon: DELHI.lon + 0.001 }).x).toBeGreaterThan(0);
  });
});

describe('bearing', () => {
  it('reads clockwise from true north', () => {
    expect(bearingDegrees(DELHI, { lat: DELHI.lat + 0.01, lon: DELHI.lon })).toBeCloseTo(0, 1);
    expect(bearingDegrees(DELHI, { lat: DELHI.lat, lon: DELHI.lon + 0.01 })).toBeCloseTo(90, 1);
    expect(bearingDegrees(DELHI, { lat: DELHI.lat - 0.01, lon: DELHI.lon })).toBeCloseTo(180, 1);
    expect(bearingDegrees(DELHI, { lat: DELHI.lat, lon: DELHI.lon - 0.01 })).toBeCloseTo(270, 1);
  });

  it('names the direction someone would actually walk', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(44)).toBe('NE');
    expect(compassPoint(180)).toBe('S');
    expect(compassPoint(359)).toBe('N');
  });
});

describe('framing', () => {
  it('keeps an uncertainty circle inside the frame', () => {
    // Cropping the search area off the edge of the map would be the one
    // failure mode that actively sends somebody the wrong way.
    const b = boundsOf([{ x: 0, y: 0, radiusM: 140 }], 10);
    expect(b.minX).toBeLessThanOrEqual(-140);
    expect(b.maxY).toBeGreaterThanOrEqual(140);
  });

  it('gives a lone point a usable span instead of dividing by zero', () => {
    const b = boundsOf([{ x: 12, y: -3 }], 80);
    expect(b.maxX - b.minX).toBeCloseTo(80, 6);
    expect(Number.isFinite(fitBounds(b, 320, 320).pxPerM)).toBe(true);
  });

  it('never zooms in past what a GPS fix can justify', () => {
    const b = boundsOf([{ x: 0, y: 0 }, { x: 0.4, y: 0 }], 1);
    expect(fitBounds(b, 360, 360, 40, 4).pxPerM).toBeLessThanOrEqual(4);
  });

  it('fits both axes of a wide scene', () => {
    const b = { minX: -500, maxX: 500, minY: -50, maxY: 50 };
    const fit = fitBounds(b, 300, 300, 20, 100);
    expect(fit.pxPerM * 1000).toBeLessThanOrEqual(300 - 40 + 1e-9);
    expect(fit.centre).toEqual({ x: 0, y: 0 });
  });
});

describe('scale furniture', () => {
  it('picks a round distance that fits the bar', () => {
    const bar = scaleBar(1, 96);
    expect(bar.meters).toBe(50);
    expect(bar.px).toBeLessThanOrEqual(96);
  });

  it('degrades to the smallest step rather than none when zoomed right in', () => {
    expect(scaleBar(40, 96).meters).toBe(5);
  });

  it('spaces range rings so three of them cover the view', () => {
    const rings = rangeRings(300);
    expect(rings).toHaveLength(3);
    expect(rings[0]).toBeLessThanOrEqual(100);
    expect(rings[2]).toBe(rings[0] * 3);
  });
});
