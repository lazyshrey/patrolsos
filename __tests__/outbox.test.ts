import { createHash } from 'node:crypto';
import { MeshEngine } from '../src/core/meshEngine';
import { Outbox, OUTBOX_TTL_MS } from '../src/core/outbox';
import { MockMesh, MockTransport } from '../src/transport/MockTransport';
import { Category, Triage, type Packet } from '../src/types';

const sha256 = (input: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(input).digest());

function pkt(over: Partial<Packet> = {}): Packet {
  return {
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
    originNodeId: 9,
    ...over,
  };
}

describe('Outbox', () => {
  it('starts entries pending', () => {
    const o = new Outbox(() => 1000);
    const e = o.add(pkt());
    expect(e.state).toBe('pending');
    expect(e.echoes).toBe(0);
    expect(o.pending()).toHaveLength(1);
  });

  it('marks delivered on the first echo only', () => {
    const o = new Outbox(() => 1000);
    o.add(pkt({ packetId: 42 }));

    expect(o.noteEcho(42)).toBe(true); // first echo is the receipt
    expect(o.noteEcho(42)).toBe(false); // later echoes are not new news
    expect(o.noteEcho(42)).toBe(false);

    const e = o.get(42)!;
    expect(e.state).toBe('delivered');
    expect(e.echoes).toBe(3);
    expect(e.firstEchoAt).toBe(1000);
    expect(o.pending()).toHaveLength(0);
  });

  it('ignores echoes for packets we never sent', () => {
    const o = new Outbox(() => 1000);
    expect(o.noteEcho(999)).toBe(false);
  });

  it('expires unacknowledged packets after the TTL', () => {
    let now = 1000;
    const o = new Outbox(() => now);
    o.add(pkt({ packetId: 7 }));

    now += OUTBOX_TTL_MS - 1;
    expect(o.sweep()).toBe(0);
    expect(o.get(7)!.state).toBe('pending');

    now += 2;
    expect(o.sweep()).toBe(1);
    expect(o.get(7)!.state).toBe('expired');
    expect(o.pending()).toHaveLength(0);
  });

  it('never expires something already delivered', () => {
    let now = 1000;
    const o = new Outbox(() => now);
    o.add(pkt({ packetId: 7 }));
    o.noteEcho(7);

    now += OUTBOX_TTL_MS * 2;
    o.sweep();
    expect(o.get(7)!.state).toBe('delivered');
  });

  it('a status update refreshes the entry rather than duplicating it', () => {
    const o = new Outbox(() => 1000);
    o.add(pkt({ packetId: 5, status: 0 }));
    o.add(pkt({ packetId: 5, status: 2, lamport: 4 }));

    expect(o.all()).toHaveLength(1);
    expect(o.get(5)!.packet.status).toBe(2);
  });

  it('pending() returns oldest first — longest wait is most urgent', () => {
    let now = 1000;
    const o = new Outbox(() => now);
    o.add(pkt({ packetId: 1 }));
    now += 500;
    o.add(pkt({ packetId: 2 }));
    now += 500;
    o.add(pkt({ packetId: 3 }));

    expect(o.pending().map((e) => e.packetId)).toEqual([1, 2, 3]);
  });

  it('reports accurate stats', () => {
    let now = 1000;
    const o = new Outbox(() => now);
    o.add(pkt({ packetId: 1 }));
    o.add(pkt({ packetId: 2 }));
    o.add(pkt({ packetId: 3 }));
    o.noteEcho(1);
    now += OUTBOX_TTL_MS + 1;
    // packet 3 was added at the same instant as 2, both now stale
    o.sweep();

    const s = o.stats();
    expect(s.delivered).toBe(1);
    expect(s.expired).toBe(2);
    expect(s.pending).toBe(0);
  });
});

describe('delivery receipts over a real mesh', () => {
  it('confirms delivery when a peer relays our packet', async () => {
    const mesh = new MockMesh();
    mesh.link(1, 2);
    const nodes = [1, 2].map(
      (id) => new MeshEngine({ nodeId: id, transport: new MockTransport(mesh, id), sha256 })
    );
    for (const n of nodes) await n.start();

    const p = nodes[0].originate({
      lat: 28.6,
      lon: 77.2,
      category: Category.MEDICAL,
      triage: Triage.RED,
      casualties: 3,
      descPreset: 1,
    });

    // Before anyone has heard it, it is unconfirmed.
    expect(nodes[0].outbox.get(p.packetId)!.state).toBe('pending');

    mesh.settle(4);

    // Node 2 relayed it, we heard our own packet come back with hops > 0.
    expect(nodes[0].outbox.get(p.packetId)!.state).toBe('delivered');
    expect(nodes[0].outbox.stats().delivered).toBe(1);

    for (const n of nodes) await n.stop();
  });

  it('stays pending when nobody is in range', async () => {
    const mesh = new MockMesh(); // no links at all
    const engine = new MeshEngine({
      nodeId: 1,
      transport: new MockTransport(mesh, 1),
      sha256,
    });
    await engine.start();

    const p = engine.originate({
      lat: 1,
      lon: 1,
      category: Category.WATER,
      triage: Triage.YELLOW,
      casualties: 1,
      descPreset: 8,
    });

    mesh.settle(20);

    expect(engine.outbox.get(p.packetId)!.state).toBe('pending');
    expect(engine.outbox.stats().pending).toBe(1);

    await engine.stop();
  });

  it('delivers a queued packet once a peer finally appears', async () => {
    const mesh = new MockMesh();
    const nodes = [1, 2].map(
      (id) => new MeshEngine({ nodeId: id, transport: new MockTransport(mesh, id), sha256 })
    );
    for (const n of nodes) await n.start();

    // Alone: report goes nowhere.
    const p = nodes[0].originate({
      lat: 5,
      lon: 5,
      category: Category.EVACUATION,
      triage: Triage.RED,
      casualties: 8,
      descPreset: 20,
    });
    mesh.settle(6);
    expect(nodes[0].outbox.get(p.packetId)!.state).toBe('pending');

    // Someone walks into range.
    mesh.link(1, 2);
    mesh.settle(6);

    expect(nodes[0].outbox.get(p.packetId)!.state).toBe('delivered');
    expect(nodes[1].getIncidents()).toHaveLength(1);

    for (const n of nodes) await n.stop();
  });

  it('a relayed foreign packet is not mistaken for our own receipt', async () => {
    const mesh = new MockMesh();
    mesh.link(1, 2);
    const nodes = [1, 2].map(
      (id) => new MeshEngine({ nodeId: id, transport: new MockTransport(mesh, id), sha256 })
    );
    for (const n of nodes) await n.start();

    nodes[1].originate({
      lat: 3,
      lon: 3,
      category: Category.FOOD,
      triage: Triage.GREEN,
      casualties: 1,
      descPreset: 12,
    });
    mesh.settle(6);

    // Node 1 authored nothing, so its outbox must stay empty.
    expect(nodes[0].outbox.all()).toHaveLength(0);

    for (const n of nodes) await n.stop();
  });
});
