import { createHash } from 'node:crypto';
import { MeshEngine } from '../src/core/meshEngine';
import { MockMesh, MockTransport } from '../src/transport/MockTransport';
import { Category, Triage } from '../src/types';

const sha256 = (input: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(input).digest());

function buildLine() {
  const mesh = new MockMesh();
  mesh.link(1, 2);
  mesh.link(2, 3);
  const nodes = [1, 2, 3].map(
    (id) => new MeshEngine({ nodeId: id, transport: new MockTransport(mesh, id), sha256 })
  );
  return { mesh, nodes };
}

describe('presence beacons', () => {
  it('gives a neighbour our position', async () => {
    const { mesh, nodes } = buildLine();
    const [n1, n2] = nodes;
    for (const n of nodes) await n.start();

    n1.announcePresence(28.6139, 77.209);
    mesh.settle(4);

    const peer = n2.getPeers().find((p) => p.nodeId === 1);
    expect(peer).toBeDefined();
    expect(peer!.lat).toBeCloseTo(28.6139, 5);
    expect(peer!.lon).toBeCloseTo(77.209, 5);

    for (const n of nodes) await n.stop();
  });

  it('never lands in the incident store', async () => {
    const { mesh, nodes } = buildLine();
    const [n1, n2, n3] = nodes;
    for (const n of nodes) await n.start();

    n1.announcePresence(28.6139, 77.209);
    mesh.settle(6);

    expect(n2.getIncidents()).toHaveLength(0);
    expect(n3.getIncidents()).toHaveLength(0);

    for (const n of nodes) await n.stop();
  });

  it('does not flood the whole mesh — low TTL keeps it local', async () => {
    const mesh = new MockMesh();
    const ids = [1, 2, 3, 4, 5, 6];
    for (let i = 0; i < ids.length - 1; i++) mesh.link(ids[i], ids[i + 1]);
    const nodes = ids.map(
      (id) => new MeshEngine({ nodeId: id, transport: new MockTransport(mesh, id), sha256 })
    );
    for (const n of nodes) await n.start();

    nodes[0].announcePresence(1, 1);
    mesh.settle(20);

    // ttl 2 => reaches nodes 2 and 3, not the far end of the chain.
    const knows = nodes.filter((n) => n.getPeers().some((p) => p.nodeId === 1)).length;
    expect(knows).toBeGreaterThanOrEqual(1);
    expect(knows).toBeLessThan(ids.length - 1);

    for (const n of nodes) await n.stop();
  });

  it('a moving peer does not fill the rotation with breadcrumbs', async () => {
    const { mesh, nodes } = buildLine();
    const [n1, n2] = nodes;
    for (const n of nodes) await n.start();

    for (let i = 0; i < 10; i++) {
      n1.announcePresence(28.6139 + i * 0.001, 77.209 + i * 0.001);
      mesh.settle(2);
    }

    // Only the newest presence per node survives in the rotation.
    expect(n1.getRotationSize()).toBe(1);

    const peer = n2.getPeers().find((p) => p.nodeId === 1);
    expect(peer!.lat).toBeCloseTo(28.6139 + 9 * 0.001, 4);

    for (const n of nodes) await n.stop();
  });

  it('an incident packet does not overwrite a peer position', async () => {
    const { mesh, nodes } = buildLine();
    const [n1, n2] = nodes;
    for (const n of nodes) await n.start();

    n1.announcePresence(10, 10);
    mesh.settle(3);

    // The incident is somewhere else entirely — the reporter did not move.
    n1.originate({
      lat: 50,
      lon: 50,
      category: Category.MEDICAL,
      triage: Triage.RED,
      casualties: 2,
      descPreset: 1,
    });
    mesh.settle(3);

    const peer = n2.getPeers().find((p) => p.nodeId === 1)!;
    expect(peer.lat).toBeCloseTo(10, 5);
    expect(peer.lon).toBeCloseTo(10, 5);
    expect(n2.getIncidents()[0].lat).toBeCloseTo(50, 5);

    for (const n of nodes) await n.stop();
  });

  it('survives a codec round-trip as a normal packet', async () => {
    const { mesh, nodes } = buildLine();
    const [n1, n3] = [nodes[0], nodes[2]];
    for (const n of nodes) await n.start();

    n1.announcePresence(-33.8688, 151.2093);
    mesh.settle(4);

    // Node 3 is two hops away; ttl 2 still reaches it.
    const peer = n3.getPeers().find((p) => p.nodeId === 1);
    expect(peer?.lat).toBeCloseTo(-33.8688, 5);
    expect(peer?.lon).toBeCloseTo(151.2093, 5);

    for (const n of nodes) await n.stop();
  });
});
