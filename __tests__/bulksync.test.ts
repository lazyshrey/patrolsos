import { createHash } from 'node:crypto';
import { MeshEngine } from '../src/core/meshEngine';
import { MockMesh, MockTransport } from '../src/transport/MockTransport';
import { Category, Status, Triage } from '../src/types';

const sha256 = (input: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(input).digest());

function lone(nodeId: number) {
  const mesh = new MockMesh();
  return new MeshEngine({ nodeId, transport: new MockTransport(mesh, nodeId), sha256 });
}

describe('Wi-Fi bulk sync', () => {
  it('transfers an entire store between two isolated nodes', async () => {
    const a = lone(1);
    const b = lone(2);
    await a.start();
    await b.start();

    for (let i = 0; i < 12; i++) {
      a.originate({
        lat: 28.6 + i * 0.01,
        lon: 77.2 + i * 0.01,
        category: Category.MEDICAL,
        triage: Triage.RED,
        casualties: i + 1,
        descPreset: 1,
      });
    }

    expect(b.getIncidents()).toHaveLength(0);

    const blob = a.exportAll();
    expect(blob.length).toBe(12 * 20);

    const accepted = b.importBulk(blob);
    expect(accepted).toBe(12);
    expect(b.getIncidents()).toHaveLength(12);

    await a.stop();
    await b.stop();
  });

  it('is idempotent — re-syncing the same store adds nothing', async () => {
    const a = lone(1);
    const b = lone(2);
    await a.start();
    await b.start();

    a.originate({
      lat: 1,
      lon: 1,
      category: Category.WATER,
      triage: Triage.YELLOW,
      casualties: 4,
      descPreset: 8,
    });

    const blob = a.exportAll();
    expect(b.importBulk(blob)).toBe(1);
    expect(b.importBulk(blob)).toBe(0);
    expect(b.getIncidents()).toHaveLength(1);

    await a.stop();
    await b.stop();
  });

  it('respects the status lattice — bulk cannot regress a resolved incident', async () => {
    const a = lone(1);
    const b = lone(2);
    await a.start();
    await b.start();

    const p = a.originate({
      lat: 5,
      lon: 5,
      category: Category.SHELTER,
      triage: Triage.GREEN,
      casualties: 1,
      descPreset: 17,
    });

    b.importBulk(a.exportAll());
    b.setStatus(p.packetId, Status.RESOLVED);
    expect(b.getIncident(p.packetId)!.status).toBe(Status.RESOLVED);

    // A's copy is still REPORTED. Syncing it in must not undo the resolution.
    b.importBulk(a.exportAll());
    expect(b.getIncident(p.packetId)!.status).toBe(Status.RESOLVED);

    await a.stop();
    await b.stop();
  });

  it('survives a truncated or corrupt blob without throwing', async () => {
    const b = lone(2);
    await b.start();

    // Nothing to read.
    expect(b.importBulk(new Uint8Array(0))).toBe(0);
    // Shorter than a single packet — no whole frame, so nothing is decoded.
    expect(b.importBulk(new Uint8Array(7))).toBe(0);

    // Undecodable frames: 0xff is an impossible status and triage.
    const junk = new Uint8Array(40);
    junk.fill(0xff);
    expect(b.importBulk(junk)).toBe(0);
    expect(b.getIncidents()).toHaveLength(0);
    expect(b.stats.dropped).toBeGreaterThanOrEqual(2);

    // Trailing bytes that do not complete a frame are ignored, not misread.
    const oneValid = lone(3);
    await oneValid.start();
    oneValid.originate({
      lat: 12,
      lon: 12,
      category: Category.FIRE,
      triage: Triage.RED,
      casualties: 1,
      descPreset: 27,
    });
    const ragged = new Uint8Array(25);
    ragged.set(oneValid.exportAll().subarray(0, 20));
    expect(b.importBulk(ragged)).toBe(1);
    expect(b.getIncidents()).toHaveLength(1);

    await oneValid.stop();
    await b.stop();
  });

  it('merges rather than overwrites when both sides have data', async () => {
    const a = lone(1);
    const b = lone(2);
    await a.start();
    await b.start();

    a.originate({
      lat: 10,
      lon: 10,
      category: Category.MEDICAL,
      triage: Triage.RED,
      casualties: 2,
      descPreset: 1,
    });
    b.originate({
      lat: 20,
      lon: 20,
      category: Category.FOOD,
      triage: Triage.GREEN,
      casualties: 5,
      descPreset: 12,
    });

    // Symmetric exchange, as the socket does.
    const fromA = a.exportAll();
    const fromB = b.exportAll();
    b.importBulk(fromA);
    a.importBulk(fromB);

    expect(a.getIncidents()).toHaveLength(2);
    expect(b.getIncidents()).toHaveLength(2);

    await a.stop();
    await b.stop();
  });
});
