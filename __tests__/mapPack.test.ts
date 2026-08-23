import {
  boxesOverlap,
  decodeMapPack,
  ranksForSpan,
  selectLines,
  selectPoints,
} from '../src/core/mapPack';
import { fromBase64 } from '../src/services/base64';
import { MAP_PACK_BASE64, MAP_PACK_BBOX, MAP_PACK_COUNTRY } from '../src/assets/mapPack';

// ---------------------------------------------------------------------------
// A hand-built pack, so the decoder is tested against bytes we wrote on purpose
// rather than only against whatever the generator happened to emit.
// ---------------------------------------------------------------------------

function synthetic(): Uint8Array {
  const parts: number[] = [];
  const u8 = (v: number) => parts.push(v & 0xff);
  const u16 = (v: number) => {
    u8(v);
    u8(v >> 8);
  };
  const u32 = (v: number) => {
    u16(v);
    u16(v >> 16);
  };
  const i16 = (v: number) => u16(v < 0 ? v + 0x10000 : v);
  const i32 = (v: number) => u32(v < 0 ? v + 0x100000000 : v);
  const f64 = (v: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    b.forEach((x) => u8(x));
  };
  const str = (s: string) => {
    const bytes = Array.from(new TextEncoder().encode(s));
    u8(bytes.length);
    bytes.forEach(u8);
  };

  'PMP1'.split('').forEach((c) => u8(c.charCodeAt(0)));
  f64(0);
  f64(0);
  f64(10);
  f64(10);
  f64(1e5); // scale
  str('Testland');
  u16(2);

  str('road');
  u8(0); // line
  u32(1);
  u8(2); // rank
  u16(3); // three points
  i32(100000); // start: lon 1.0
  i32(200000); //        lat 2.0
  i16(20000); // -> lon 1.2
  i16(-10000); // -> lat 1.9
  i16(-5000); // -> lon 1.15
  i16(30000); // -> lat 2.2

  str('city');
  u8(1); // point
  u32(2);
  u8(0);
  i32(300000);
  i32(400000);
  str('Ürümqi'); // multi-byte, to prove the UTF-8 path
  u8(3);
  i32(900000);
  i32(950000);
  str('Far');

  return new Uint8Array(parts);
}

describe('pack decoding', () => {
  const pack = decodeMapPack(synthetic());

  it('reads the header', () => {
    expect(pack.country).toBe('Testland');
    expect(pack.bbox).toEqual([0, 0, 10, 10]);
    expect([...pack.layers.keys()]).toEqual(['road', 'city']);
  });

  it('rebuilds absolute coordinates from stored deltas', () => {
    const line = pack.layers.get('road')!.lines[0];
    expect(line.rank).toBe(2);
    expect(Array.from(line.coords)).toEqual([1.0, 2.0, 1.2, 1.9, 1.15, 2.2]);
  });

  it('precomputes a bounding box that actually contains the line', () => {
    const line = pack.layers.get('road')!.lines[0];
    expect(line.bbox[0]).toBeCloseTo(1.0, 9);
    expect(line.bbox[1]).toBeCloseTo(1.9, 9);
    expect(line.bbox[2]).toBeCloseTo(1.2, 9);
    expect(line.bbox[3]).toBeCloseTo(2.2, 9);
  });

  it('decodes multi-byte place names', () => {
    // Half the cities in the world have a name that is not ASCII. Getting this
    // wrong turns a label into mojibake, which is worse than no label.
    expect(pack.layers.get('city')!.points[0].name).toBe('Ürümqi');
    expect(pack.layers.get('city')!.points[0].lon).toBeCloseTo(3.0, 9);
    expect(pack.layers.get('city')!.points[0].lat).toBeCloseTo(4.0, 9);
  });

  it('refuses anything that is not a pack', () => {
    expect(() => decodeMapPack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/map pack/);
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('selection', () => {
  const pack = decodeMapPack(synthetic());

  it('detects overlapping and disjoint boxes', () => {
    expect(boxesOverlap([0, 0, 2, 2], [1, 1, 3, 3])).toBe(true);
    expect(boxesOverlap([0, 0, 1, 1], [2, 2, 3, 3])).toBe(false);
    // Touching at an edge still counts: a road ending exactly on the viewport
    // boundary is visible.
    expect(boxesOverlap([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true);
  });

  it('drops features outside the viewport', () => {
    expect(selectLines(pack.layers.get('road'), [0, 0, 5, 5], 4)).toHaveLength(1);
    expect(selectLines(pack.layers.get('road'), [8, 8, 9, 9], 4)).toHaveLength(0);
  });

  it('drops features too unimportant for the zoom', () => {
    expect(selectLines(pack.layers.get('road'), [0, 0, 5, 5], 1)).toHaveLength(0);
    expect(selectPoints(pack.layers.get('city'), [0, 0, 10, 10], 0)).toHaveLength(1);
    expect(selectPoints(pack.layers.get('city'), [0, 0, 10, 10], 3)).toHaveLength(2);
  });

  it('treats a negative rank as the layer being switched off', () => {
    expect(selectLines(pack.layers.get('road'), [0, 0, 5, 5], -1)).toHaveLength(0);
    expect(selectPoints(pack.layers.get('city'), [0, 0, 10, 10], -1)).toHaveLength(0);
  });

  it('survives a missing layer', () => {
    expect(selectLines(undefined, [0, 0, 1, 1], 4)).toEqual([]);
    expect(selectPoints(undefined, [0, 0, 1, 1], 4)).toEqual([]);
  });
});

describe('zoom ranks', () => {
  it('reveals more of the map as you zoom in, never less', () => {
    const spans = [3000, 1000, 400, 120, 20];
    const seen = spans.map(ranksForSpan);
    for (const layer of ['river', 'road', 'city', 'lake'] as const) {
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i][layer]).toBeGreaterThanOrEqual(seen[i - 1][layer]);
      }
    }
  });

  it('hides roads at country scale and shows them once they mean something', () => {
    // A whole country's road network rendered at 3000 km across is a grey
    // smear that tells you nothing and costs a frame to draw.
    expect(ranksForSpan(3000).road).toBeLessThan(0);
    expect(ranksForSpan(20).road).toBeGreaterThanOrEqual(3);
  });

  it('always keeps the coastline, which is what makes it recognisable', () => {
    for (const span of [5000, 1000, 100, 5, 0.3]) {
      expect(ranksForSpan(span).coast).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The real shipped pack
// ---------------------------------------------------------------------------

describe('the bundled India pack', () => {
  const pack = decodeMapPack(fromBase64(MAP_PACK_BASE64));

  it('carries every layer the renderer asks for', () => {
    expect(pack.country).toBe(MAP_PACK_COUNTRY);
    for (const name of ['coast', 'state', 'river', 'lake', 'road', 'city']) {
      const layer = pack.layers.get(name);
      expect(layer).toBeDefined();
      expect(layer!.lines.length + layer!.points.length).toBeGreaterThan(0);
    }
  });

  it('stays inside its declared bounding box', () => {
    // A delta that overflowed its int16 would land a road in the Pacific, and
    // this is the assertion that would catch it.
    const [minLon, minLat, maxLon, maxLat] = MAP_PACK_BBOX;
    for (const layer of pack.layers.values()) {
      for (const line of layer.lines) {
        expect(line.bbox[0]).toBeGreaterThanOrEqual(minLon - 1);
        expect(line.bbox[2]).toBeLessThanOrEqual(maxLon + 1);
        expect(line.bbox[1]).toBeGreaterThanOrEqual(minLat - 1);
        expect(line.bbox[3]).toBeLessThanOrEqual(maxLat + 1);
      }
      for (const p of layer.points) {
        expect(p.lon).toBeGreaterThanOrEqual(minLon);
        expect(p.lon).toBeLessThanOrEqual(maxLon);
      }
    }
  });

  it('has no degenerate lines', () => {
    for (const layer of pack.layers.values()) {
      for (const line of layer.lines) {
        expect(line.coords.length).toBeGreaterThanOrEqual(4);
        expect(line.coords.length % 2).toBe(0);
      }
    }
  });

  it('knows the cities somebody would actually look for', () => {
    const names = new Set(pack.layers.get('city')!.points.map((p) => p.name));
    for (const city of ['Delhi', 'Mumbai', 'Kolkata', 'Chennai', 'Bengaluru']) {
      expect(names).toContain(city);
    }
  });

  it('places Delhi where Delhi is', () => {
    const delhi = pack.layers.get('city')!.points.find((p) => p.name === 'Delhi')!;
    expect(delhi.lon).toBeCloseTo(77.2, 0);
    expect(delhi.lat).toBeCloseTo(28.6, 0);
    // A national capital has to survive to the most zoomed-out rank, or the
    // country map opens with no labels at all.
    expect(delhi.rank).toBe(0);
  });

  it('carries the major river systems', () => {
    const rivers = pack.layers.get('river')!.lines;
    expect(rivers.length).toBeGreaterThan(50);
    expect(rivers.some((r) => r.rank === 0)).toBe(true);
  });

  it('is small enough to ship', () => {
    // The entire premise is that this fits in an APK next to everything else.
    expect(MAP_PACK_BASE64.length).toBeLessThan(600 * 1024);
  });
});
