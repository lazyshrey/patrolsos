import { createHash } from 'node:crypto';
import { MeshEngine } from '../src/core/meshEngine';
import { MockMesh, MockTransport } from '../src/transport/MockTransport';
import { describeProximity } from '../src/core/localization';
import { Category, Triage } from '../src/types';

const sha256 = (input: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(input).digest());

function pair() {
  const mesh = new MockMesh();
  mesh.link(1, 2);
  const nodes = [1, 2].map(
    (id) => new MeshEngine({ nodeId: id, transport: new MockTransport(mesh, id), sha256 })
  );
  return { mesh, nodes };
}

describe('peer liveness (regression: peers vanished while in range)', () => {
  it('a duplicate packet still counts as hearing the peer', async () => {
    const { mesh, nodes } = pair();
    const [n1, n2] = nodes;
    for (const n of nodes) await n.start();

    n1.originate({
      lat: 1,
      lon: 1,
      category: Category.MEDICAL,
      triage: Triage.RED,
      casualties: 1,
      descPreset: 1,
    });

    mesh.settle(1);
    const first = n2.getPeers().find((p) => p.nodeId === 1)!;
    expect(first).toBeDefined();
    const heardAfterFirst = first.packetsHeard;

    // Nothing new is said, but node 1 keeps re-advertising the same packet.
    mesh.settle(10);

    const later = n2.getPeers().find((p) => p.nodeId === 1)!;
    // Before the fix this stayed flat, and the peer eventually went stale and
    // disappeared while standing right there.
    expect(later.packetsHeard).toBeGreaterThan(heardAfterFirst);

    for (const n of nodes) await n.stop();
  });

  it('keeps refreshing lastSeen from duplicates', async () => {
    const mesh = new MockMesh();
    mesh.link(1, 2);
    let clock = 1_000_000;
    const nodes = [1, 2].map(
      (id) =>
        new MeshEngine({
          nodeId: id,
          transport: new MockTransport(mesh, id),
          sha256,
          now: () => clock,
        })
    );
    for (const n of nodes) await n.start();

    nodes[0].originate({
      lat: 1,
      lon: 1,
      category: Category.WATER,
      triage: Triage.YELLOW,
      casualties: 1,
      descPreset: 8,
    });
    mesh.settle(1);
    const t0 = nodes[1].getPeers()[0].lastSeen;

    clock += 45_000; // well past PEER_STALE_MS
    mesh.settle(2); // only duplicates arrive

    expect(nodes[1].getPeers()[0].lastSeen).toBeGreaterThan(t0);

    for (const n of nodes) await n.stop();
  });

  it('a relayed copy does not demote a peer we also hear directly', async () => {
    const { mesh, nodes } = pair();
    const [, n2] = nodes;
    await n2.start();

    // Direct sighting first, then a 3-hop copy of the same node.
    n2.receive(
      {
        packetId: 1,
        lat: 1,
        lon: 1,
        category: Category.MEDICAL,
        triage: Triage.RED,
        casualties: 1,
        ttl: 7,
        hops: 0,
        lamport: 1,
        status: 0,
        descPreset: 1,
        originNodeId: 1,
      },
      -55
    );
    n2.receive(
      {
        packetId: 2,
        lat: 1,
        lon: 1,
        category: Category.MEDICAL,
        triage: Triage.RED,
        casualties: 1,
        ttl: 4,
        hops: 3,
        lamport: 2,
        status: 0,
        descPreset: 1,
        originNodeId: 1,
      },
      -90
    );

    const peer = n2.getPeers().find((p) => p.nodeId === 1)!;
    expect(peer.hops).toBe(0); // best known route, not the latest one
    expect(peer.rssi).toBe(-55); // relay strength must not overwrite direct

    await n2.stop();
  });

  it('smooths a jumpy signal instead of tracking every spike', async () => {
    const { nodes } = pair();
    const n2 = nodes[1];
    await n2.start();

    const base = {
      lat: 1,
      lon: 1,
      category: Category.MEDICAL,
      triage: Triage.RED as Triage,
      casualties: 1,
      ttl: 7,
      hops: 0,
      status: 0 as const,
      descPreset: 1,
      originNodeId: 1,
    };

    n2.receive({ ...base, packetId: 10, lamport: 1 }, -60);
    n2.receive({ ...base, packetId: 11, lamport: 2 }, -90); // one bad reading

    const peer = n2.getPeers().find((p) => p.nodeId === 1)!;
    // Must not have snapped all the way to -90.
    expect(peer.rssi).toBeGreaterThan(-80);
    expect(peer.rssi).toBeLessThan(-60);

    await n2.stop();
  });
});

describe('describeProximity', () => {
  it('does not claim metres for phones sitting together', () => {
    // GPS says 9 m; the radio says they are touching. The radio wins.
    const p = describeProximity({ hops: 0, rssi: -50, gpsDistanceM: 9 });
    expect(p.label).toBe('right here');
    expect(p.detail).not.toMatch(/\d+ m/);
  });

  it('uses metres once GPS separation beats its own error', () => {
    const p = describeProximity({ hops: 0, rssi: -80, gpsDistanceM: 250 });
    expect(p.detail).toMatch(/m away/);
  });

  it('switches to kilometres when far', () => {
    expect(describeProximity({ hops: 0, rssi: -90, gpsDistanceM: 2400 }).detail).toBe(
      '2.4 km away'
    );
  });

  it('reports relayed peers as relayed regardless of signal', () => {
    expect(describeProximity({ hops: 2, rssi: -50, gpsDistanceM: 5 }).label).toBe('relayed');
  });

  it('degrades to a band when there is no GPS at all', () => {
    expect(describeProximity({ hops: 0, rssi: -70, gpsDistanceM: null }).label).toBe('nearby');
    expect(describeProximity({ hops: 0, rssi: -95, gpsDistanceM: null }).label).toBe('in range');
  });
});
