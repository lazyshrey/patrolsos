import { buildScene } from '../src/core/mapScene';
import type { SceneInput } from '../src/core/mapScene';
import type { Cluster } from '../src/core/deduplicator';
import type { PeerState } from '../src/types';
import { Category, Status, Triage } from '../src/types';

const HERE = { lat: 28.6139, lon: 77.209 };
const NOW = 1_700_000_000_000;

function peer(nodeId: number, over: Partial<PeerState> = {}): PeerState {
  return {
    nodeId,
    rssi: -70,
    lastSeen: NOW,
    packetsHeard: 4,
    hops: 0,
    ...over,
  };
}

function cluster(over: Partial<Cluster> = {}): Cluster {
  return {
    id: 1,
    lat: 28.615,
    lon: 77.21,
    category: Category.MEDICAL,
    triage: Triage.RED,
    casualties: 1,
    status: Status.REPORTED,
    firstSeen: NOW,
    lastSeen: NOW,
    minHops: 0,
    reportCount: 1,
    mine: false,
    members: [],
    ...over,
  };
}

function scene(over: Partial<SceneInput> = {}) {
  return buildScene({
    selfNodeId: 1,
    fix: HERE,
    peers: [],
    estimates: [],
    clusters: [],
    answers: [],
    observations: [],
    now: NOW,
    ...over,
  });
}

describe('scene origin', () => {
  it('anchors on this phone when it has a fix', () => {
    const out = scene({ peers: [peer(2, { lat: 28.615, lon: 77.21 })] });
    expect(out.anchoredToSelf).toBe(true);
    expect(out.origin).toEqual(HERE);
    const self = out.markers.find((m) => m.kind === 'self')!;
    expect(self.x).toBeCloseTo(0, 6);
    expect(self.y).toBeCloseTo(0, 6);
  });

  it('falls back to the middle of everyone else when this phone has no fix', () => {
    // Losing your own fix must not blank the map: the network still knows
    // where it is, and that picture is still worth having.
    const out = scene({
      fix: null,
      peers: [peer(2, { lat: 28.61, lon: 77.2 }), peer(3, { lat: 28.62, lon: 77.22 })],
    });
    expect(out.anchoredToSelf).toBe(false);
    expect(out.origin!.lat).toBeCloseTo(28.615, 6);
    expect(out.markers.some((m) => m.kind === 'self')).toBe(false);
    expect(out.markers.every((m) => m.distanceM === null)).toBe(true);
  });

  it('reports nothing placeable rather than inventing an origin', () => {
    const out = scene({ fix: null, peers: [peer(2)] });
    expect(out.origin).toBeNull();
    expect(out.markers).toHaveLength(0);
    expect(out.unplaced.map((u) => u.label)).toContain('You');
  });
});

describe('what gets placed', () => {
  it('treats the engine null-island placeholder as no position at all', () => {
    // The engine sends (0, 0) when a report is filed without a fix. Drawing
    // that as a pin would put a casualty in the Gulf of Guinea.
    const out = scene({
      peers: [peer(2, { lat: 0, lon: 0 })],
      clusters: [cluster({ lat: 0, lon: 0 })],
    });
    expect(out.markers.filter((m) => m.kind !== 'self')).toHaveLength(0);
    expect(out.unplaced).toHaveLength(2);
  });

  it('prefers a real fix over an estimate for the same phone', () => {
    const out = scene({
      peers: [peer(2, { lat: 28.615, lon: 77.21 })],
      estimates: [
        {
          targetNodeId: 2,
          lat: 28.62,
          lon: 77.22,
          uncertaintyM: 60,
          observerCount: 3,
          method: 'trilateration',
        },
      ],
    });
    const forTwo = out.markers.filter((m) => m.nodeId === 2);
    expect(forTwo).toHaveLength(1);
    expect(forTwo[0].kind).toBe('direct');
    expect(forTwo[0].accuracyM).toBe(0);
  });

  it('gives an estimated position a radius and never a bare point', () => {
    const out = scene({
      estimates: [
        {
          targetNodeId: 7,
          lat: 28.6145,
          lon: 77.2095,
          uncertaintyM: 2,
          observerCount: 3,
          method: 'trilateration',
        },
      ],
    });
    const est = out.markers.find((m) => m.kind === 'estimate')!;
    // Even an optimistic solver output gets a floor: RSSI ranging is never
    // accurate to two metres, and drawing it that way would be a lie.
    expect(est.accuracyM).toBeGreaterThanOrEqual(8);
  });

  it('separates phones heard directly from phones reached through a relay', () => {
    const out = scene({
      peers: [
        peer(2, { lat: 28.615, lon: 77.21, hops: 0 }),
        peer(3, { lat: 28.616, lon: 77.211, hops: 2 }),
      ],
    });
    expect(out.markers.find((m) => m.nodeId === 2)!.kind).toBe('direct');
    expect(out.markers.find((m) => m.nodeId === 3)!.kind).toBe('relayed');
  });

  it('measures distance and bearing from this phone', () => {
    const out = scene({ peers: [peer(2, { lat: 28.6139, lon: 77.2101 })] });
    const p = out.markers.find((m) => m.nodeId === 2)!;
    expect(p.distanceM).toBeGreaterThan(90);
    expect(p.distanceM).toBeLessThan(120);
    expect(p.bearingDeg).toBeCloseTo(90, 0);
  });
});

describe('links', () => {
  it('draws our own radio links and marks them as ours', () => {
    const out = scene({ peers: [peer(2, { lat: 28.615, lon: 77.21 })] });
    expect(out.links).toHaveLength(1);
    expect(out.links[0].own).toBe(true);
  });

  it('draws links between two phones that are not us', () => {
    // This is the whole reason observations are on the map: the shape of the
    // network past your own radio is invisible in any list.
    const out = scene({
      peers: [
        peer(2, { lat: 28.615, lon: 77.21 }),
        peer(3, { lat: 28.616, lon: 77.212, hops: 1 }),
      ],
      observations: [
        { observerNodeId: 2, observer: { lat: 28.615, lon: 77.21 }, targetNodeId: 3, rssi: -65, at: NOW },
      ],
    });
    const between = out.links.find((l) => l.id === '2-3')!;
    expect(between).toBeDefined();
    expect(between.own).toBe(false);
  });

  it('draws one line per pair however many times it is observed', () => {
    const obs = (a: number, b: number) => ({
      observerNodeId: a,
      observer: HERE,
      targetNodeId: b,
      rssi: -70,
      at: NOW,
    });
    const out = scene({
      peers: [peer(2, { lat: 28.615, lon: 77.21 }), peer(3, { lat: 28.616, lon: 77.212 })],
      observations: [obs(2, 3), obs(3, 2), obs(2, 3)],
    });
    expect(out.links.filter((l) => l.id === '2-3')).toHaveLength(1);
  });

  it('skips links to a phone it cannot place', () => {
    const out = scene({
      peers: [peer(2, { lat: 28.615, lon: 77.21 })],
      observations: [{ observerNodeId: 2, observer: HERE, targetNodeId: 9, rssi: -70, at: NOW }],
    });
    expect(out.links.every((l) => l.id !== '2-9')).toBe(true);
  });

  it('weights a strong link more heavily than a faint one', () => {
    const strong = scene({ peers: [peer(2, { lat: 28.615, lon: 77.21, rssi: -55 })] });
    const faint = scene({ peers: [peer(2, { lat: 28.615, lon: 77.21, rssi: -94 })] });
    expect(strong.links[0].strength).toBeGreaterThan(faint.links[0].strength);
    expect(faint.links[0].strength).toBeGreaterThan(0);
  });
});

describe('ringing', () => {
  const answer = (at: number) => ({
    responderNodeId: 2,
    callerNodeId: 1,
    lat: 28.615,
    lon: 77.21,
    battery: 40,
    hops: 0,
    at,
  });

  it('marks a phone as ringing while its answers are still arriving', () => {
    const out = scene({
      peers: [peer(2, { lat: 28.615, lon: 77.21 })],
      answers: [answer(NOW - 3_000)],
    });
    expect(out.markers.find((m) => m.nodeId === 2)!.ringing).toBe(true);
  });

  it('stops marking it once the answers go stale', () => {
    // An alarm ends by itself. Nothing tells us that it has, so silence is the
    // only evidence, and the map has to stop claiming a sound that stopped.
    const out = scene({
      peers: [peer(2, { lat: 28.615, lon: 77.21 })],
      answers: [answer(NOW - 60_000)],
    });
    expect(out.markers.find((m) => m.nodeId === 2)!.ringing).toBe(false);
  });
});

describe('what could not be placed', () => {
  it('counts the phones and reports left off the map', () => {
    const out = scene({
      peers: [peer(2), peer(3), peer(4, { lat: 28.615, lon: 77.21 })],
      clusters: [cluster({ id: 1, lat: 0, lon: 0 }), cluster({ id: 2 })],
    });
    expect(out.unplaced).toEqual([
      { label: '2 phones', reason: 'heard, but has not shared a position' },
      { label: '1 report', reason: 'sent by a phone with no fix' },
    ]);
  });
});
