import { createHash } from 'node:crypto';
import { MeshEngine } from '../src/core/meshEngine';
import { MockMesh, MockTransport } from '../src/transport/MockTransport';
import { estimateError } from '../src/core/localization';
import { Category, Triage } from '../src/types';

const sha256 = (input: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(input).digest());

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;
const ORIGIN = { lat: 28.6139, lon: 77.209 };

function offset(dx: number, dy: number) {
  const latRad = (ORIGIN.lat * Math.PI) / 180;
  return {
    lat: ORIGIN.lat + dy / M_PER_DEG_LAT,
    lon: ORIGIN.lon + dx / (M_PER_DEG_LON * Math.cos(latRad)),
  };
}

function rssiFor(observer: { lat: number; lon: number }, truth: { lat: number; lon: number }) {
  const latRad = (observer.lat * Math.PI) / 180;
  const d = Math.hypot(
    (truth.lon - observer.lon) * M_PER_DEG_LON * Math.cos(latRad),
    (truth.lat - observer.lat) * M_PER_DEG_LAT
  );
  return -59 - 10 * 2.7 * Math.log10(Math.max(d, 1));
}

/** Everyone hears everyone, so observations can be gossiped normally. */
function fullMesh(ids: number[]) {
  const mesh = new MockMesh();
  for (const a of ids) for (const b of ids) if (a !== b) mesh.link(a, b);
  const nodes = ids.map(
    (id) => new MeshEngine({ nodeId: id, transport: new MockTransport(mesh, id), sha256 })
  );
  return { mesh, nodes };
}

describe('OBSERVATION packets', () => {
  it('survives the 20-byte codec round trip with target and rssi intact', async () => {
    const { mesh, nodes } = fullMesh([1, 2]);
    for (const n of nodes) await n.start();

    nodes[0].announceObservation(77, -72, ORIGIN.lat, ORIGIN.lon);
    mesh.settle(4);

    const seen = nodes[1].getObservations();
    expect(seen).toHaveLength(1);
    expect(seen[0].targetNodeId).toBe(77);
    expect(seen[0].rssi).toBe(-72);
    expect(seen[0].observerNodeId).toBe(1);
    expect(seen[0].observer.lat).toBeCloseTo(ORIGIN.lat, 5);

    for (const n of nodes) await n.stop();
  });

  it('never lands in the incident store', async () => {
    const { mesh, nodes } = fullMesh([1, 2]);
    for (const n of nodes) await n.start();

    nodes[0].announceObservation(50, -80, ORIGIN.lat, ORIGIN.lon);
    mesh.settle(4);

    expect(nodes[1].getIncidents()).toHaveLength(0);

    for (const n of nodes) await n.stop();
  });

  it('ignores an observation of ourselves', async () => {
    const { mesh, nodes } = fullMesh([1, 2]);
    for (const n of nodes) await n.start();

    nodes[0].announceObservation(2, -70, ORIGIN.lat, ORIGIN.lon);
    mesh.settle(4);

    // Node 2 is the target — it already knows where it is.
    expect(nodes[1].getObservations()).toHaveLength(0);

    for (const n of nodes) await n.stop();
  });

  it('supersedes rather than accumulates per observer-target pair', async () => {
    const { mesh, nodes } = fullMesh([1, 2]);
    for (const n of nodes) await n.start();

    for (const rssi of [-60, -65, -70, -75]) {
      nodes[0].announceObservation(88, rssi, ORIGIN.lat, ORIGIN.lon);
      mesh.settle(2);
    }

    const obs = nodes[1].getObservations();
    expect(obs).toHaveLength(1);
    expect(obs[0].rssi).toBe(-75); // the newest reading

    for (const n of nodes) await n.stop();
  });

  it('three observers let a fourth node be located end to end', async () => {
    // Nodes 1,2,3 are observers with GPS. Node 9 is the silent target.
    const { mesh, nodes } = fullMesh([1, 2, 3]);
    const [n1, n2, n3] = nodes;
    for (const n of nodes) await n.start();

    const truth = offset(30, 25);
    const posts: Array<[MeshEngine, { lat: number; lon: number }]> = [
      [n1, ORIGIN],
      [n2, offset(80, 0)],
      [n3, offset(0, 80)],
    ];

    for (const [node, at] of posts) {
      node.announceObservation(9, rssiFor(at, truth), at.lat, at.lon);
    }
    mesh.settle(6);

    // Any node holding all three observations can solve it.
    const est = n1.getLocationEstimates().find((e) => e.targetNodeId === 9)!;
    expect(est).toBeDefined();
    expect(est.method).toBe('trilateration');
    expect(est.observerCount).toBe(3);
    expect(estimateError(est, truth)).toBeLessThan(15);
    expect(est.uncertaintyM).toBeGreaterThanOrEqual(15);

    for (const n of nodes) await n.stop();
  });

  it('suppresses an estimate for a node that reports its own GPS', async () => {
    const { mesh, nodes } = fullMesh([1, 2, 3]);
    const [n1, n2, n3] = nodes;
    for (const n of nodes) await n.start();

    // Node 2 announces a real fix, and is also observed by the others.
    n2.announcePresence(ORIGIN.lat, ORIGIN.lon);
    n1.announceObservation(2, -70, ORIGIN.lat, ORIGIN.lon);
    n3.announceObservation(2, -75, offset(50, 0).lat, offset(50, 0).lon);
    mesh.settle(6);

    // A real fix beats an RSSI guess — no circle drawn over a phone that knows.
    expect(n1.getLocationEstimates().some((e) => e.targetNodeId === 2)).toBe(false);

    for (const n of nodes) await n.stop();
  });

  it('sweepObservations reports on every peer currently heard', async () => {
    const { mesh, nodes } = fullMesh([1, 2, 3]);
    const [n1, n2, n3] = nodes;
    for (const n of nodes) await n.start();

    // Generate traffic so n1 learns about 2 and 3.
    n2.originate({
      lat: 1,
      lon: 1,
      category: Category.MEDICAL,
      triage: Triage.RED,
      casualties: 1,
      descPreset: 1,
    });
    n3.originate({
      lat: 2,
      lon: 2,
      category: Category.WATER,
      triage: Triage.YELLOW,
      casualties: 1,
      descPreset: 8,
    });
    mesh.settle(4);

    expect(n1.getPeers().length).toBe(2);
    expect(n1.sweepObservations(ORIGIN.lat, ORIGIN.lon)).toBe(2);

    for (const n of nodes) await n.stop();
  });
});
