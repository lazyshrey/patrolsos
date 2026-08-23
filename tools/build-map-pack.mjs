/**
 * Build a country map pack.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app has to show a map with no network, which rules out tiles: they are
 * downloaded, always, by every map you have ever used. The alternative is to
 * ship the geometry itself — but a street-level extract of a country is
 * gigabytes, so the honest trade is to ship a STRIPPED map: coastline, state
 * borders, major rivers, major roads and cities. Enough to know where you are
 * and which way the river runs. Not enough to navigate a lane.
 *
 * Source is Natural Earth 10m, which is public domain (no attribution
 * required) and cut for exactly this scale. Output is a few hundred KB.
 *
 * Run:
 *   node tools/build-map-pack.mjs --data <dir-of-geojson> --country IND
 *
 * The pipeline is country-agnostic; --country and its bounding box are the
 * only things that change. Re-running for another country is one command.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Countries. Bounding box is [minLon, minLat, maxLon, maxLat].
// ---------------------------------------------------------------------------

const COUNTRIES = {
  IND: { name: 'India', bbox: [67.0, 5.5, 98.5, 37.5] },
  NPL: { name: 'Nepal', bbox: [79.5, 25.5, 89.0, 31.0] },
  BGD: { name: 'Bangladesh', bbox: [87.5, 20.0, 93.5, 27.0] },
  LKA: { name: 'Sri Lanka', bbox: [79.0, 5.5, 82.5, 10.5] },
  PAK: { name: 'Pakistan', bbox: [60.5, 23.0, 78.0, 37.5] },
};

/**
 * Simplification tolerance in degrees, per layer.
 *
 * 0.002 deg is roughly 200 m. That is invisible at the zooms this data is
 * legible at, and it removes over half the points. Rivers get a touch more
 * detail than borders because a river's wiggle is how you recognise it.
 */
const TOLERANCE = {
  coast: 0.0025,
  state: 0.003,
  river: 0.002,
  lake: 0.003,
  road: 0.002,
};

/** Quantisation grid: 1e5 units per degree, i.e. about 1.1 m. */
const SCALE = 1e5;
/** Deltas are stored as int16, so a single step cannot exceed this. */
const MAX_DELTA = 32000;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function lines(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

/** Perpendicular distance from p to the segment ab, in degrees. */
function perpDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  const c = t < 0 ? a : t > 1 ? b : [a[0] + t * dx, a[1] + t * dy];
  return Math.hypot(p[0] - c[0], p[1] - c[1]);
}

/**
 * Douglas-Peucker, iterative.
 *
 * Iterative rather than recursive on purpose: a Natural Earth coastline ring
 * can be tens of thousands of points, and the recursive form blows the stack
 * on the pathological near-collinear cases that coastlines are full of.
 */
function simplify(points, tolerance) {
  if (points.length <= 2) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function intersectsBox(line, bbox) {
  for (const c of line) {
    if (c[0] >= bbox[0] && c[0] <= bbox[2] && c[1] >= bbox[1] && c[1] <= bbox[3]) return true;
  }
  return false;
}

/**
 * Clip a line to the bounding box, keeping only the runs inside it.
 *
 * One point of slack is kept on each side of a crossing so a road does not
 * visibly stop short of the border it actually crosses.
 */
function clipRuns(line, bbox) {
  const inside = (c) => c[0] >= bbox[0] && c[0] <= bbox[2] && c[1] >= bbox[1] && c[1] <= bbox[3];
  const runs = [];
  let run = null;
  for (let i = 0; i < line.length; i++) {
    if (inside(line[i])) {
      if (!run) {
        run = [];
        if (i > 0) run.push(line[i - 1]);
      }
      run.push(line[i]);
    } else if (run) {
      run.push(line[i]);
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs.filter((r) => r.length >= 2);
}

// ---------------------------------------------------------------------------
// Binary writer
// ---------------------------------------------------------------------------

class Writer {
  constructor() {
    this.buf = Buffer.alloc(1 << 20);
    this.len = 0;
  }
  _need(n) {
    while (this.len + n > this.buf.length) {
      const bigger = Buffer.alloc(this.buf.length * 2);
      this.buf.copy(bigger, 0, 0, this.len);
      this.buf = bigger;
    }
  }
  u8(v) { this._need(1); this.buf.writeUInt8(v, this.len); this.len += 1; }
  u16(v) { this._need(2); this.buf.writeUInt16LE(v, this.len); this.len += 2; }
  u32(v) { this._need(4); this.buf.writeUInt32LE(v, this.len); this.len += 4; }
  i16(v) { this._need(2); this.buf.writeInt16LE(v, this.len); this.len += 2; }
  i32(v) { this._need(4); this.buf.writeInt32LE(v, this.len); this.len += 4; }
  f64(v) { this._need(8); this.buf.writeDoubleLE(v, this.len); this.len += 8; }
  ascii(s) {
    const b = Buffer.from(s, 'utf8').subarray(0, 255);
    this.u8(b.length);
    this._need(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }
  done() { return this.buf.subarray(0, this.len); }
}

// ---------------------------------------------------------------------------
// Layer extraction
// ---------------------------------------------------------------------------

function readJson(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

/** Natural Earth spells its country codes differently in every layer. */
function countryOf(props) {
  return (
    props.adm0_a3 ?? props.ADM0_A3 ?? props.iso_a3 ?? props.ISO_A3 ?? props.sov_a3 ?? props.SOV_A3
  );
}

function buildLineLayer(features, { bbox, tolerance, rankOf, clip }) {
  const out = [];
  for (const f of features) {
    const rank = rankOf(f.properties);
    if (rank == null) continue;
    for (const line of lines(f.geometry)) {
      if (!intersectsBox(line, bbox)) continue;
      const pieces = clip ? clipRuns(line, bbox) : [line];
      for (const piece of pieces) {
        const s = simplify(piece, tolerance);
        if (s.length >= 2) out.push({ rank, points: s });
      }
    }
  }
  return out;
}

/**
 * Insert intermediate vertices wherever one step is too long to survive an
 * int16 delta.
 *
 * Simplification bounds how far a line strays from its original, not how long
 * a single segment is: a dead-straight highway legitimately becomes one step
 * hundreds of kilometres long. Subdividing is lossless — the inserted points
 * sit exactly on the segment — whereas splitting the feature would leave a
 * visible gap in a road that has none.
 */
function densify(points, maxStep) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / maxStep);
    for (let s = 1; s < steps; s++) {
      out.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps]);
    }
    out.push(b);
  }
  return out;
}

function writeLineLayer(w, name, features) {
  const maxStep = (MAX_DELTA / SCALE) * 0.9;
  const split = [];
  for (const f of features) {
    const dense = densify(f.points, maxStep);
    // pointCount is a u16, so a very long ring is emitted as consecutive
    // chunks that share a vertex and therefore draw as one unbroken line.
    for (let i = 0; i < dense.length - 1; i += 65000) {
      const chunk = dense.slice(i, Math.min(dense.length, i + 65001));
      if (chunk.length >= 2) split.push({ rank: f.rank, points: chunk });
    }
  }

  w.ascii(name);
  w.u8(0); // kind: line
  w.u32(split.length);
  let points = 0;
  for (const f of split) {
    w.u8(Math.min(255, f.rank));
    w.u16(f.points.length);
    let px = Math.round(f.points[0][0] * SCALE);
    let py = Math.round(f.points[0][1] * SCALE);
    w.i32(px);
    w.i32(py);
    for (let i = 1; i < f.points.length; i++) {
      const x = Math.round(f.points[i][0] * SCALE);
      const y = Math.round(f.points[i][1] * SCALE);
      w.i16(x - px);
      w.i16(y - py);
      px = x;
      py = y;
    }
    points += f.points.length;
  }
  return { features: split.length, points };
}

function writePointLayer(w, name, features) {
  w.ascii(name);
  w.u8(1); // kind: point
  w.u32(features.length);
  for (const f of features) {
    w.u8(Math.min(255, f.rank));
    w.i32(Math.round(f.lon * SCALE));
    w.i32(Math.round(f.lat * SCALE));
    w.ascii(f.name ?? '');
  }
  return { features: features.length, points: features.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataDir = arg('--data');
const code = arg('--country', 'IND');
const outFile = arg('--out', 'src/assets/mapPack.ts');

if (!dataDir) {
  console.error('usage: node tools/build-map-pack.mjs --data <geojson-dir> [--country IND]');
  process.exit(1);
}
const country = COUNTRIES[code];
if (!country) {
  console.error(`unknown country ${code}; known: ${Object.keys(COUNTRIES).join(', ')}`);
  process.exit(1);
}
const bbox = country.bbox;

console.log(`Building ${country.name} (${code}) pack from ${dataDir}`);

// --- coastline / national outline -----------------------------------------
const admin0 = readJson(dataDir, 'ne_10m_admin_0_countries.geojson');
const coast = buildLineLayer(
  admin0.features.filter((f) => countryOf(f.properties) === code),
  { bbox, tolerance: TOLERANCE.coast, rankOf: () => 0, clip: false }
);

// --- state borders ---------------------------------------------------------
const admin1 = readJson(dataDir, 'ne_10m_admin_1_states_provinces.geojson');
const states = buildLineLayer(
  admin1.features.filter((f) => countryOf(f.properties) === code),
  { bbox, tolerance: TOLERANCE.state, rankOf: () => 0, clip: false }
);

// --- rivers ----------------------------------------------------------------
// scalerank is Natural Earth's importance measure, and it is NOT a zoom level:
// over India it runs 1-9, and a naive division put the Ganges and the Indus
// three zooms deep, so the country view had no rivers on it at all. The bands
// below are chosen against the actual named rivers in the extract — rank 0 is
// "you would draw this from memory", rank 4 is a tributary.
const riverRank = (sr) => (sr <= 3 ? 0 : sr <= 5 ? 1 : sr <= 7 ? 2 : sr <= 8 ? 3 : 4);
const rivers = buildLineLayer(readJson(dataDir, 'ne_10m_rivers_lake_centerlines.geojson').features, {
  bbox,
  tolerance: TOLERANCE.river,
  rankOf: (p) => riverRank(p.scalerank ?? 9),
  clip: true,
});

// --- lakes -----------------------------------------------------------------
// Same trap, different range: no lake in the extract scores better than 4.
const lakeRank = (sr) => (sr <= 5 ? 0 : sr <= 6 ? 1 : sr <= 7 ? 2 : sr <= 8 ? 3 : 4);
const lakes = buildLineLayer(readJson(dataDir, 'ne_10m_lakes.geojson').features, {
  bbox,
  tolerance: TOLERANCE.lake,
  rankOf: (p) => lakeRank(p.scalerank ?? 9),
  clip: false,
});

// --- roads -----------------------------------------------------------------
// Outside North America, Natural Earth's roads carry no names and a coarse
// type, so rank comes from type first and scalerank second. Tracks are dropped:
// at this resolution they are noise that looks like a road.
const ROAD_RANK = { 'Major Highway': 0, Highway: 0, Road: 1, Ferry: 3, Unknown: 2, Track: null };
const roads = buildLineLayer(readJson(dataDir, 'ne_10m_roads.geojson').features, {
  bbox,
  tolerance: TOLERANCE.road,
  rankOf: (p) => {
    const base = ROAD_RANK[p.type];
    if (base == null) return null;
    if (p.expressway === 1) return 0;
    return Math.min(3, base + (p.scalerank >= 9 ? 1 : 0));
  },
  clip: true,
});

// --- cities ----------------------------------------------------------------
// Rank is population, because at a glance the only thing that matters about a
// dot on a country map is whether it is a landmark you have heard of.
const places = readJson(dataDir, 'ne_10m_populated_places.geojson').features
  .filter((f) => countryOf(f.properties) === code)
  .map((f) => {
    const p = f.properties;
    const pop = p.POP_MAX ?? 0;
    const rank = p.ADM0CAP === 1 ? 0 : pop >= 5e6 ? 0 : pop >= 1e6 ? 1 : pop >= 3e5 ? 2 : 3;
    return { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], name: p.NAME, rank, pop };
  })
  .sort((a, b) => a.rank - b.rank || b.pop - a.pop);

// --- write -----------------------------------------------------------------
const w = new Writer();
w.buf.write('PMP1', 0, 'ascii');
w.len = 4;
w.f64(bbox[0]);
w.f64(bbox[1]);
w.f64(bbox[2]);
w.f64(bbox[3]);
w.f64(SCALE);
w.ascii(country.name);
w.u16(6);

const stats = {};
stats.coast = writeLineLayer(w, 'coast', coast);
stats.state = writeLineLayer(w, 'state', states);
stats.river = writeLineLayer(w, 'river', rivers);
stats.lake = writeLineLayer(w, 'lake', lakes);
stats.road = writeLineLayer(w, 'road', roads);
stats.city = writePointLayer(w, 'city', places);

const bin = w.done();
const b64 = bin.toString('base64');

const ts = `/**
 * ${country.name} map pack — GENERATED, do not edit by hand.
 *
 * Built by tools/build-map-pack.mjs from Natural Earth 10m (public domain).
 * Coastline, state borders, rivers, lakes, major roads and cities, simplified
 * to ${(TOLERANCE.road * 111).toFixed(0)}-${(TOLERANCE.state * 111).toFixed(0)} m and quantised to a ${(111000 / SCALE).toFixed(1)} m grid.
 *
 * Decoded by src/core/mapPack.ts. Regenerate with:
 *   node tools/build-map-pack.mjs --data <geojson-dir> --country ${code}
 */

export const MAP_PACK_COUNTRY = ${JSON.stringify(country.name)};
export const MAP_PACK_BBOX = ${JSON.stringify(bbox)} as const;

export const MAP_PACK_BASE64 =
  '${b64}';
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, ts);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const source = { coast, state: states, river: rivers, lake: lakes, road: roads, city: places };
console.log('');
for (const [name, s] of Object.entries(stats)) {
  const hist = [0, 1, 2, 3, 4].map((r) => source[name].filter((f) => f.rank === r).length);
  const flag = hist[0] === 0 ? '  <-- nothing at rank 0: invisible when zoomed out' : '';
  console.log(
    `  ${name.padEnd(6)} ${String(s.features).padStart(6)} features  ${String(s.points).padStart(7)} points  ranks ${hist.join('/')}${flag}`
  );
}
console.log('');
console.log(`  binary  ${kb(bin.length)}`);
console.log(`  base64  ${kb(b64.length)}`);
console.log(`  wrote   ${outFile}`);
