/**
 * Reading a bundled country map pack.
 *
 * The pack is the offline basemap: coastline, state borders, rivers, lakes,
 * major roads and cities, built from Natural Earth by tools/build-map-pack.mjs
 * and shipped inside the APK. There is no tile server to fall back to, so this
 * is the only geography the app will ever have.
 *
 * FORMAT
 * ------
 * Little-endian, and deliberately dull:
 *
 *   'PMP1'                        magic
 *   f64 x4                        bbox, degrees
 *   f64                           quantisation scale, units per degree
 *   u8 len + utf8                 country name
 *   u16                           layer count
 *   per layer:
 *     u8 len + utf8               layer name
 *     u8                          kind: 0 line, 1 point
 *     u32                         feature count
 *     line feature:  u8 rank, u16 pointCount, i32 x0, i32 y0, then i16 dx/dy
 *     point feature: u8 rank, i32 x, i32 y, u8 len + utf8 name
 *
 * Coordinates are stored as deltas because a road is a sequence of small steps;
 * that alone is most of the difference between a 275 KB pack and a 1 MB one.
 *
 * Pure module: no react-native, no expo.
 */

const MAGIC = 0x504d5031; // 'PMP1'

export interface LineFeature {
  /** Lower is more important. Drives which zooms this is drawn at. */
  rank: number;
  /** Interleaved [lon, lat, lon, lat, ...] in degrees. */
  coords: Float64Array;
  /** [minLon, minLat, maxLon, maxLat], precomputed so culling is a compare. */
  bbox: [number, number, number, number];
}

export interface PointFeature {
  rank: number;
  lon: number;
  lat: number;
  name: string;
}

export interface PackLayer {
  name: string;
  kind: 'line' | 'point';
  lines: LineFeature[];
  points: PointFeature[];
}

export interface MapPack {
  country: string;
  bbox: [number, number, number, number];
  layers: Map<string, PackLayer>;
}

class Reader {
  private view: DataView;
  private at = 0;

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    return this.view.getUint8(this.at++);
  }
  u16(): number {
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.at, true);
    this.at += 2;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.at, true);
    this.at += 4;
    return v;
  }
  f64(): number {
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }
  str(): string {
    const len = this.u8();
    let out = '';
    // Pack strings are place names, so decode UTF-8 properly rather than
    // assuming ASCII: "Bengaluru" is fine either way, plenty of others are not.
    let i = 0;
    while (i < len) {
      const b = this.bytes[this.at + i];
      if (b < 0x80) {
        out += String.fromCharCode(b);
        i += 1;
      } else if (b < 0xe0) {
        out += String.fromCharCode(((b & 0x1f) << 6) | (this.bytes[this.at + i + 1] & 0x3f));
        i += 2;
      } else if (b < 0xf0) {
        out += String.fromCharCode(
          ((b & 0x0f) << 12) |
            ((this.bytes[this.at + i + 1] & 0x3f) << 6) |
            (this.bytes[this.at + i + 2] & 0x3f)
        );
        i += 3;
      } else {
        const cp =
          ((b & 0x07) << 18) |
          ((this.bytes[this.at + i + 1] & 0x3f) << 12) |
          ((this.bytes[this.at + i + 2] & 0x3f) << 6) |
          (this.bytes[this.at + i + 3] & 0x3f);
        out += String.fromCodePoint(cp);
        i += 4;
      }
    }
    this.at += len;
    return out;
  }
}

export function decodeMapPack(bytes: Uint8Array): MapPack {
  const r = new Reader(bytes);

  const magic = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  if (magic !== MAGIC) {
    throw new Error('not a PATROL map pack');
  }
  // Consume the magic through the reader so offsets stay in one place.
  r.u32();

  const bbox: [number, number, number, number] = [r.f64(), r.f64(), r.f64(), r.f64()];
  const scale = r.f64();
  const country = r.str();
  const layerCount = r.u16();

  const layers = new Map<string, PackLayer>();

  for (let l = 0; l < layerCount; l++) {
    const name = r.str();
    const kind = r.u8() === 0 ? 'line' : 'point';
    const count = r.u32();
    const layer: PackLayer = { name, kind, lines: [], points: [] };

    if (kind === 'line') {
      for (let f = 0; f < count; f++) {
        const rank = r.u8();
        const n = r.u16();
        const coords = new Float64Array(n * 2);

        let x = r.i32();
        let y = r.i32();
        let minLon = x / scale;
        let maxLon = minLon;
        let minLat = y / scale;
        let maxLat = minLat;
        coords[0] = minLon;
        coords[1] = minLat;

        for (let i = 1; i < n; i++) {
          x += r.i16();
          y += r.i16();
          const lon = x / scale;
          const lat = y / scale;
          coords[i * 2] = lon;
          coords[i * 2 + 1] = lat;
          if (lon < minLon) minLon = lon;
          else if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          else if (lat > maxLat) maxLat = lat;
        }

        layer.lines.push({ rank, coords, bbox: [minLon, minLat, maxLon, maxLat] });
      }
    } else {
      for (let f = 0; f < count; f++) {
        const rank = r.u8();
        const lon = r.i32() / scale;
        const lat = r.i32() / scale;
        layer.points.push({ rank, lon, lat, name: r.str() });
      }
    }

    layers.set(name, layer);
  }

  return { country, bbox, layers };
}

/** True when the two boxes touch at all. */
export function boxesOverlap(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Which layers and ranks are worth drawing at a given span.
 *
 * The whole point of ranks: at 2000 km you want six cities and the coastline,
 * and at 20 km you want every road in the pack. Drawing all of it at every zoom
 * would be both unreadable and slow.
 *
 * `spanKm` is the width of what the viewport currently covers.
 */
export function ranksForSpan(spanKm: number): Record<string, number> {
  if (spanKm > 1500) return { coast: 0, state: -1, river: 0, lake: 0, road: -1, city: 0 };
  if (spanKm > 700) return { coast: 0, state: 0, river: 1, lake: 0, road: 0, city: 1 };
  if (spanKm > 250) return { coast: 0, state: 0, river: 2, lake: 1, road: 1, city: 2 };
  if (spanKm > 80) return { coast: 0, state: 0, river: 3, lake: 2, road: 2, city: 3 };
  return { coast: 0, state: 0, river: 4, lake: 4, road: 3, city: 3 };
}

/**
 * Everything in `layer` that is inside `bbox` and important enough for `maxRank`.
 * A maxRank below zero means the layer is switched off at this zoom.
 */
export function selectLines(
  layer: PackLayer | undefined,
  bbox: readonly [number, number, number, number],
  maxRank: number
): LineFeature[] {
  if (!layer || maxRank < 0) return [];
  const out: LineFeature[] = [];
  for (const f of layer.lines) {
    if (f.rank <= maxRank && boxesOverlap(f.bbox, bbox)) out.push(f);
  }
  return out;
}

export function selectPoints(
  layer: PackLayer | undefined,
  bbox: readonly [number, number, number, number],
  maxRank: number
): PointFeature[] {
  if (!layer || maxRank < 0) return [];
  const out: PointFeature[] = [];
  for (const p of layer.points) {
    if (
      p.rank <= maxRank &&
      p.lon >= bbox[0] &&
      p.lon <= bbox[2] &&
      p.lat >= bbox[1] &&
      p.lat <= bbox[3]
    ) {
      out.push(p);
    }
  }
  return out;
}
