import { analyseBridge, bridgeMessage, buildGraph } from '../src/core/topology';
import type { Observation } from '../src/core/localization';
import type { PeerState } from '../src/types';

function peer(nodeId: number, hops = 0, rssi = -60): PeerState {
  return { nodeId, rssi, lastSeen: 1000, packetsHeard: 5, hops };
}

function obs(observerNodeId: number, targetNodeId: number, rssi = -65): Observation {
  return {
    observerNodeId,
    observer: { lat: 0, lon: 0 },
    targetNodeId,
    rssi,
    at: 1000,
  };
}

describe('buildGraph', () => {
  it('adds an edge to every direct peer', () => {
    const g = buildGraph(1, [peer(2), peer(3)], []);
    expect([...g.get(1)!]).toEqual([2, 3]);
  });

  it('ignores peers we only reach through a relay', () => {
    const g = buildGraph(1, [peer(2, 0), peer(3, 2)], []);
    expect([...g.get(1)!]).toEqual([2]);
  });

  it('turns observations into edges between other nodes', () => {
    const g = buildGraph(1, [], [obs(2, 3)]);
    expect(g.get(2)!.has(3)).toBe(true);
    expect(g.get(3)!.has(2)).toBe(true);
  });

  it('discards links too weak to be evidence', () => {
    const g = buildGraph(1, [], [obs(2, 3, -100)]);
    expect(g.get(2)).toBeUndefined();
  });
});

describe('analyseBridge', () => {
  it('flags us when two peers can only reach each other through us', () => {
    // 2 -- me -- 3, and nobody has ever reported 2 hearing 3.
    const status = analyseBridge(1, [peer(2), peer(3)], []);
    expect(status.isBridge).toBe(true);
    expect(status.groups).toHaveLength(2);
  });

  it('does not flag us when our peers can hear each other', () => {
    // 2 -- me -- 3, and 2 also hears 3 directly. Removing us changes nothing.
    const status = analyseBridge(1, [peer(2), peer(3)], [obs(2, 3)]);
    expect(status.isBridge).toBe(false);
  });

  it('cannot be a bridge with fewer than two direct peers', () => {
    expect(analyseBridge(1, [], []).isBridge).toBe(false);
    expect(analyseBridge(1, [peer(2)], []).isBridge).toBe(false);
  });

  it('handles a chain where we sit in the middle of two clusters', () => {
    // Cluster A: 2,3 (hear each other). Cluster B: 4,5. We touch both.
    const status = analyseBridge(
      1,
      [peer(2), peer(4)],
      [obs(2, 3), obs(4, 5)]
    );
    expect(status.isBridge).toBe(true);
    expect(status.groups).toHaveLength(2);
    const sizes = status.groups.map((g) => g.length).sort();
    expect(sizes).toEqual([2, 2]);
  });

  it('names a single phone that would be cut off entirely', () => {
    // 3 is a lone node hanging off us; 2 belongs to a group that survives.
    const status = analyseBridge(1, [peer(2), peer(3)], [obs(2, 4)]);
    expect(status.isBridge).toBe(true);
    expect(status.isolated).toContain(3);
  });

  it('is not fooled by a fully connected cluster', () => {
    const status = analyseBridge(
      1,
      [peer(2), peer(3), peer(4)],
      [obs(2, 3), obs(3, 4), obs(2, 4)]
    );
    expect(status.isBridge).toBe(false);
  });
});

describe('bridgeMessage', () => {
  it('says nothing when we are not a bridge', () => {
    expect(bridgeMessage({ isBridge: false, groups: [], isolated: [] })).toBeNull();
  });

  it('speaks plainly and never promises certainty', () => {
    const msg = bridgeMessage(analyseBridge(1, [peer(2), peer(4)], [obs(2, 3), obs(4, 5)]))!;
    expect(msg).toMatch(/may lose contact/);
    expect(msg).not.toMatch(/will lose/);
  });

  it('has a specific wording for one stranded phone', () => {
    const msg = bridgeMessage(analyseBridge(1, [peer(2), peer(3)], [obs(2, 4)]))!;
    expect(msg).toMatch(/only reach the others through you/);
  });
});
