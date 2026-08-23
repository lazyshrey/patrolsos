import { createHash } from 'node:crypto';
import { MeshEngine } from '../src/core/meshEngine';
import { MockMesh, MockTransport } from '../src/transport/MockTransport';
import {
  BUZZ_ALL,
  BuzzGate,
  clampRingSeconds,
  positionOrNull,
  type BuzzRequest,
} from '../src/core/buzz';
import { Category } from '../src/types';

const sha256 = (input: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(input).digest());

/** 1 — 2 — 3, so node 1 can only reach node 3 through node 2. */
function buildLine(onBuzz?: Array<((b: BuzzRequest) => void) | undefined>) {
  const mesh = new MockMesh();
  mesh.link(1, 2);
  mesh.link(2, 3);
  const nodes = [1, 2, 3].map(
    (id) =>
      new MeshEngine({
        nodeId: id,
        transport: new MockTransport(mesh, id),
        sha256,
        onBuzz: onBuzz?.[id - 1],
      })
  );
  return { mesh, nodes };
}

function req(over: Partial<BuzzRequest> = {}): BuzzRequest {
  return {
    callerNodeId: 7,
    targetNodeId: BUZZ_ALL,
    lat: null,
    lon: null,
    seconds: 30,
    press: 1,
    forMe: true,
    hops: 0,
    at: 0,
    ...over,
  };
}

describe('buzz wire fields', () => {
  it('clamps a ring duration into the byte we can actually send', () => {
    expect(clampRingSeconds(30)).toBe(30);
    expect(clampRingSeconds(1)).toBe(5);
    expect(clampRingSeconds(9999)).toBe(180);
    expect(clampRingSeconds(NaN)).toBe(30);
  });

  it('reads 0,0 as "no fix" rather than as the Gulf of Guinea', () => {
    expect(positionOrNull(0, 0)).toEqual({ lat: null, lon: null });
    expect(positionOrNull(28.6, 77.2)).toEqual({ lat: 28.6, lon: 77.2 });
  });
});

describe('BuzzGate', () => {
  it('rings once per press however many copies arrive', () => {
    const gate = new BuzzGate(() => 1000);
    const b = req({ press: 4 });
    expect(gate.admit(b)).toBe(true);
    expect(gate.admit({ ...b, hops: 1 })).toBe(false);
    expect(gate.admit({ ...b, hops: 2 })).toBe(false);
  });

  it('rate-limits a caller pressing over and over', () => {
    let now = 1000;
    const gate = new BuzzGate(() => now);
    expect(gate.admit(req({ press: 1 }))).toBe(true);
    now += 5000;
    expect(gate.admit(req({ press: 2 }))).toBe(false);
    now += 20_000;
    expect(gate.admit(req({ press: 3 }))).toBe(true);
  });

  it('never lets a held-back press become ringable later', () => {
    let now = 1000;
    const gate = new BuzzGate(() => now);
    gate.admit(req({ press: 1 }));
    const late = req({ press: 2 });
    expect(gate.admit(late)).toBe(false);
    now += 60_000;
    // The same press arriving again by a slower route must stay silent.
    expect(gate.admit({ ...late, hops: 3 })).toBe(false);
  });

  it('consumes but never rings a buzz aimed at someone else', () => {
    const gate = new BuzzGate(() => 1000);
    const other = req({ forMe: false, press: 9 });
    expect(gate.admit(other)).toBe(false);
    // And it did not spend that caller cooldown, so a real buzz still rings.
    expect(gate.admit(req({ press: 10 }))).toBe(true);
  });
});

describe('buzz over the mesh', () => {
  it('reaches a phone two hops away and rings it', async () => {
    const rung: BuzzRequest[] = [];
    const { mesh, nodes } = buildLine([undefined, undefined, (b) => rung.push(b)]);
    for (const n of nodes) await n.start();

    nodes[0].sendBuzz(BUZZ_ALL, 28.6139, 77.209, 30);
    mesh.settle(6);

    expect(rung).toHaveLength(1);
    expect(rung[0].forMe).toBe(true);
    expect(rung[0].callerNodeId).toBe(1);
    expect(rung[0].lat).toBeCloseTo(28.6139, 5);
    expect(rung[0].hops).toBeGreaterThan(0);

    for (const n of nodes) await n.stop();
  });

  it('rings only the phone it names, but tells the others it happened', async () => {
    const heard: BuzzRequest[][] = [[], [], []];
    const { mesh, nodes } = buildLine([
      (b) => heard[0].push(b),
      (b) => heard[1].push(b),
      (b) => heard[2].push(b),
    ]);
    for (const n of nodes) await n.start();

    nodes[0].sendBuzz(3, 28.6139, 77.209, 30);
    mesh.settle(6);

    // Node 2 is told a buzz went past — that is its cue to file observations —
    // but it is not the one being rung.
    expect(heard[1]).toHaveLength(1);
    expect(heard[1][0].forMe).toBe(false);
    expect(heard[2]).toHaveLength(1);
    expect(heard[2][0].forMe).toBe(true);

    for (const n of nodes) await n.stop();
  });

  it('never rings the phone that pressed the button', async () => {
    const own: BuzzRequest[] = [];
    const { mesh, nodes } = buildLine([(b) => own.push(b), undefined, undefined]);
    for (const n of nodes) await n.start();

    nodes[0].sendBuzz(BUZZ_ALL, 28.6139, 77.209, 30);
    mesh.settle(6);

    expect(own).toHaveLength(0);
    for (const n of nodes) await n.stop();
  });

  it('carries the answer, and the answering position, back to the caller', async () => {
    const { mesh, nodes } = buildLine();
    const [caller, , target] = nodes;
    for (const n of nodes) await n.start();

    caller.sendBuzz(3, 28.6139, 77.209, 30);
    mesh.settle(6);

    target.answerBuzz(1, 28.6205, 77.2101, 42);
    mesh.settle(6);

    const [answer] = caller.getAnswers();
    expect(answer).toBeDefined();
    expect(answer.responderNodeId).toBe(3);
    expect(answer.callerNodeId).toBe(1);
    expect(answer.lat).toBeCloseTo(28.6205, 5);
    expect(answer.battery).toBe(42);

    // And the peer table now knows where node 3 is, two hops away.
    const peer = caller.getPeers().find((p) => p.nodeId === 3);
    expect(peer?.lat).toBeCloseTo(28.6205, 5);
    expect(peer?.ringingUntil).toBeGreaterThan(0);

    for (const n of nodes) await n.stop();
  });

  it('does not believe 0,0 from a phone with no fix', async () => {
    const { mesh, nodes } = buildLine();
    const [caller, , target] = nodes;
    for (const n of nodes) await n.start();

    target.answerBuzz(1, 0, 0, 55);
    mesh.settle(6);

    const [answer] = caller.getAnswers();
    expect(answer.lat).toBeNull();
    expect(answer.battery).toBe(55);
    expect(caller.getPeers().find((p) => p.nodeId === 3)?.lat).toBeUndefined();

    for (const n of nodes) await n.stop();
  });

  it('keeps buzzes out of the incident list', async () => {
    const { mesh, nodes } = buildLine();
    for (const n of nodes) await n.start();

    nodes[0].sendBuzz(BUZZ_ALL, 28.6139, 77.209, 30);
    mesh.settle(6);
    nodes[2].answerBuzz(1, 28.62, 77.21, 90);
    mesh.settle(6);

    for (const n of nodes) expect(n.getIncidents()).toHaveLength(0);
    for (const n of nodes) await n.stop();
  });

  it('supersedes an earlier press rather than stacking them on the air', async () => {
    const { mesh, nodes } = buildLine();
    const [caller] = nodes;
    await caller.start();

    caller.sendBuzz(BUZZ_ALL, 28.6139, 77.209, 30);
    const afterFirst = caller.getRotationSize();
    caller.sendBuzz(BUZZ_ALL, 28.6139, 77.209, 30);
    caller.sendBuzz(BUZZ_ALL, 28.6139, 77.209, 30);

    expect(caller.getRotationSize()).toBe(afterFirst);
    await caller.stop();
    mesh.settle(1);
  });

  it('retires a finished buzz from the air instead of announcing it forever', async () => {
    let t = 1_000;
    const mesh = new MockMesh();
    const engine = new MeshEngine({
      nodeId: 1,
      transport: new MockTransport(mesh, 1),
      sha256,
      now: () => t,
    });
    await engine.start();

    engine.sendBuzz(BUZZ_ALL, 28.6, 77.2, 10);
    expect(engine.getRotationSize()).toBe(1);

    // Ring duration plus the airtime slack.
    t += 10_000 + 15_000 + 1;
    engine.announcePresence(28.6, 77.2);

    // Only the presence packet survives; the alarm is over.
    expect(engine.getRotationSize()).toBe(1);
    await engine.stop();
  });

  it('puts the buzz at the front of the broadcast rotation', async () => {
    const { mesh, nodes } = buildLine();
    const [caller] = nodes;
    await caller.start();

    caller.originate({
      lat: 28.6,
      lon: 77.2,
      category: Category.MEDICAL,
      triage: 0,
      casualties: 1,
      descPreset: 1,
    });
    const buzz = caller.sendBuzz(BUZZ_ALL, 28.6, 77.2, 30);

    // The transport is handed the rotation in priority order; the ring has to
    // be the first thing on the air.
    const rotation = (caller as unknown as { rotation: Array<{ packetId: number }> })
      .rotation;
    expect(rotation[0].packetId).toBe(buzz.packetId);

    await caller.stop();
    mesh.settle(1);
  });
});
