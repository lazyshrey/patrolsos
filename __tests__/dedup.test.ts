import { clusterIncidents } from '../src/core/deduplicator';
import { geohashDecode, geohashEncode, geohashNeighbors, haversineMeters } from '../src/core/geo';
import { Category, Status, Triage, type Incident } from '../src/types';

let seq = 1;
function inc(over: Partial<Incident> = {}): Incident {
  const now = 1_700_000_000_000;
  return {
    packetId: seq++,
    lat: 28.6139,
    lon: 77.209,
    category: Category.MEDICAL,
    triage: Triage.YELLOW,
    casualties: 2,
    status: Status.REPORTED,
    lamport: 1,
    descPreset: 1,
    originNodeId: 1,
    firstSeen: now,
    lastSeen: now,
    hops: 0,
    reportCount: 1,
    mine: false,
    ...over,
  };
}

describe('geo', () => {
  it('haversine matches a known distance', () => {
    // Delhi -> Mumbai, ~1150 km
    const d = haversineMeters({ lat: 28.6139, lon: 77.209 }, { lat: 19.076, lon: 72.8777 });
    expect(d / 1000).toBeGreaterThan(1130);
    expect(d / 1000).toBeLessThan(1180);
  });

  it('haversine is ~0 for identical points', () => {
    expect(haversineMeters({ lat: 5, lon: 5 }, { lat: 5, lon: 5 })).toBeLessThan(0.001);
  });

  it('geohash is stable and prefix-consistent', () => {
    const h = geohashEncode(28.6139, 77.209, 6);
    expect(h).toHaveLength(6);
    expect(geohashEncode(28.6139, 77.209, 6)).toBe(h);
    expect(geohashEncode(28.6139, 77.209, 3)).toBe(h.slice(0, 3));
  });

  it('returns 8 distinct neighbours', () => {
    const n = geohashNeighbors(geohashEncode(28.6139, 77.209, 6));
    expect(n.length).toBe(8);
    expect(new Set(n).size).toBe(8);
  });
});

describe('deduplicator', () => {
  it('merges six co-located reports into one cluster', () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      inc({ lat: 28.6139 + i * 0.0002, lon: 77.209 + i * 0.0002, casualties: i + 1 })
    );
    const clusters = clusterIncidents(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reportCount).toBe(6);
    // max, not sum — one event reported six times
    expect(clusters[0].casualties).toBe(6);
  });

  it('keeps a distant report separate', () => {
    const clusters = clusterIncidents([
      inc({ lat: 28.6139, lon: 77.209 }),
      inc({ lat: 28.6169, lon: 77.209 }), // ~330 m north
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('keeps different categories separate even at the same spot', () => {
    const clusters = clusterIncidents([
      inc({ category: Category.MEDICAL }),
      inc({ category: Category.WATER }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('keeps reports outside the time window separate', () => {
    const t = 1_700_000_000_000;
    const clusters = clusterIncidents([
      inc({ firstSeen: t, lastSeen: t }),
      inc({ firstSeen: t + 20 * 60_000, lastSeen: t + 20 * 60_000 }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('merges across a geohash cell boundary', () => {
    // Construct the boundary case rather than searching for it: take a cell,
    // find its eastern edge, and straddle it by a few metres.
    const cell = geohashEncode(28.6139, 77.209, 6);
    const { lat, lon, lonErr } = geohashDecode(cell);
    const edge = lon + lonErr;

    const a = { lat, lon: edge - 0.00002 }; // ~2 m west of the edge
    const b = { lat, lon: edge + 0.00002 }; // ~2 m east of the edge

    // Precondition: genuinely different cells, genuinely close together.
    expect(geohashEncode(a.lat, a.lon, 6)).not.toBe(geohashEncode(b.lat, b.lon, 6));
    expect(haversineMeters(a, b)).toBeLessThan(20);

    const clusters = clusterIncidents([inc({ ...a }), inc({ ...b })]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].reportCount).toBe(2);
  });

  it('takes the most severe triage, never averages down', () => {
    const clusters = clusterIncidents([
      inc({ triage: Triage.GREEN }),
      inc({ triage: Triage.RED, lat: 28.61395 }),
      inc({ triage: Triage.YELLOW, lat: 28.61392 }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].triage).toBe(Triage.RED);
  });

  it('takes the highest status across members', () => {
    const clusters = clusterIncidents([
      inc({ status: Status.REPORTED }),
      inc({ status: Status.IN_PROGRESS, lat: 28.61395 }),
    ]);
    expect(clusters[0].status).toBe(Status.IN_PROGRESS);
  });

  it('orders clusters most urgent first', () => {
    const clusters = clusterIncidents([
      inc({ triage: Triage.GREEN, lat: 10, lon: 10 }),
      inc({ triage: Triage.RED, lat: 20, lon: 20 }),
      inc({ triage: Triage.YELLOW, lat: 30, lon: 30 }),
    ]);
    expect(clusters.map((c) => c.triage)).toEqual([Triage.RED, Triage.YELLOW, Triage.GREEN]);
  });

  it('assigns every incident to exactly one cluster', () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      inc({ lat: 28.6 + (i % 7) * 0.004, lon: 77.2 + (i % 5) * 0.004 })
    );
    const clusters = clusterIncidents(items);
    const total = clusters.reduce((n, c) => n + c.reportCount, 0);
    expect(total).toBe(items.length);
  });
});
