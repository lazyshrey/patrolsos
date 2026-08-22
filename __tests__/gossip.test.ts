import { createHash } from 'node:crypto';
import { MeshEngine } from '../src/core/meshEngine';
import { MockMesh, MockTransport } from '../src/transport/MockTransport';
import { Category, Status, Triage } from '../src/types';

const sha256 = (input: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(input).digest());

function buildLine() {
  // Topology: 1 <-> 2 <-> 3, with NO direct link between 1 and 3.
  const mesh = new MockMesh();
  mesh.link(1, 2);
  mesh.link(2, 3);

  const nodes = [1, 2, 3].map(
    (id) =>
      new MeshEngine({
        nodeId: id,
        transport: new MockTransport(mesh, id),
        sha256,
      })
  );
  return { mesh, nodes };
}

async function startAll(nodes: MeshEngine[]) {
  for (const n of nodes) await n.start();
}

async function stopAll(nodes: MeshEngine[]) {
  for (const n of nodes) await n.stop();
}

describe('epidemic gossip', () => {
  it('relays 1 -> 3 through 2 with no direct link', async () => {
    const { mesh, nodes } = buildLine();
    const [n1, n2, n3] = nodes;
    await startAll(nodes);

    expect(mesh.canHear(3, 1)).toBe(false);

    n1.originate({
      lat: 28.6139,
      lon: 77.209,
      category: Category.MEDICAL,
      triage: Triage.RED,
      casualties: 6,
      descPreset: 1,
    });

    mesh.settle(6);

    const onN3 = n3.getIncidents();
    expect(onN3).toHaveLength(1);
    expect(onN3[0].casualties).toBe(6);
    expect(onN3[0].triage).toBe(Triage.RED);
    // one relay through node 2
    expect(onN3[0].hops).toBe(1);
    expect(n2.getIncidents()).toHaveLength(1);

    await stopAll(nodes);
  });

  it('never rebroadcasts the same packet twice from one node', async () => {
    const { mesh, nodes } = buildLine();
    const [n1, , n3] = nodes;
    await startAll(nodes);

    n1.originate({
      lat: 1,
      lon: 1,
      category: Category.WATER,
      triage: Triage.YELLOW,
      casualties: 3,
      descPreset: 8,
    });

    mesh.settle(20);

    // Rotation is deduplicated by packetId, so it never grows unboundedly.
    expect(n3.getRotationSize()).toBe(1);
    expect(n3.getIncidents()).toHaveLength(1);

    await stopAll(nodes);
  });

  it('propagates a status change BACKWARD to the originator', async () => {
    const { mesh, nodes } = buildLine();
    const [n1, , n3] = nodes;
    await startAll(nodes);

    const p = n1.originate({
      lat: 28.6,
      lon: 77.2,
      category: Category.MEDICAL,
      triage: Triage.RED,
      casualties: 4,
      descPreset: 1,
    });

    mesh.settle(6);
    expect(n3.getIncident(p.packetId)).toBeDefined();

    // HQ (node 3) marks it in progress. Node 3 cannot reach node 1 directly.
    n3.setStatus(p.packetId, Status.IN_PROGRESS);
    mesh.settle(8);

    expect(n1.getIncident(p.packetId)!.status).toBe(Status.IN_PROGRESS);

    await stopAll(nodes);
  });

  it('status is a lattice — it never regresses', async () => {
    const { mesh, nodes } = buildLine();
    const [n1, , n3] = nodes;
    await startAll(nodes);

    const p = n1.originate({
      lat: 5,
      lon: 5,
      category: Category.SHELTER,
      triage: Triage.GREEN,
      casualties: 1,
      descPreset: 17,
    });
    mesh.settle(6);

    n3.setStatus(p.packetId, Status.RESOLVED);
    mesh.settle(8);
    expect(n1.getIncident(p.packetId)!.status).toBe(Status.RESOLVED);

    // An older, lower-status packet must not undo the resolution.
    n1.receive({ ...p, status: Status.REPORTED, lamport: 1 });
    expect(n1.getIncident(p.packetId)!.status).toBe(Status.RESOLVED);

    await stopAll(nodes);
  });

  it('terminates when ttl is exhausted', async () => {
    const mesh = new MockMesh();
    // A long chain: 1-2-3-4-5-6-7-8-9-10
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (let i = 0; i < ids.length - 1; i++) mesh.link(ids[i], ids[i + 1]);

    const nodes = ids.map(
      (id) => new MeshEngine({ nodeId: id, transport: new MockTransport(mesh, id), sha256 })
    );
    await startAll(nodes);

    nodes[0].originate({
      lat: 2,
      lon: 2,
      category: Category.FOOD,
      triage: Triage.GREEN,
      casualties: 1,
      descPreset: 12,
    });

    mesh.settle(30);

    // ttl 7 means the packet dies before reaching the far end of the chain.
    const reached = nodes.filter((n) => n.getIncidents().length > 0).length;
    expect(reached).toBeGreaterThan(1);
    expect(reached).toBeLessThan(ids.length);

    await stopAll(nodes);
  });

  it('a ring topology converges and halts', async () => {
    const mesh = new MockMesh();
    const ids = [1, 2, 3, 4, 5];
    for (let i = 0; i < ids.length; i++) {
      mesh.link(ids[i], ids[(i + 1) % ids.length]);
    }
    const nodes = ids.map(
      (id) => new MeshEngine({ nodeId: id, transport: new MockTransport(mesh, id), sha256 })
    );
    await startAll(nodes);

    nodes[0].originate({
      lat: 9,
      lon: 9,
      category: Category.EVACUATION,
      triage: Triage.RED,
      casualties: 11,
      descPreset: 20,
    });

    mesh.settle(40);

    for (const n of nodes) {
      expect(n.getIncidents()).toHaveLength(1);
      expect(n.getRotationSize()).toBe(1);
    }

    await stopAll(nodes);
  });
});
