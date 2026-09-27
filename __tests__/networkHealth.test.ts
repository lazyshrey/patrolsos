import { summarizeNetworkHealth } from '../src/core/networkHealth';
import type { PeerState } from '../src/types';

const peer = (overrides: Partial<PeerState> = {}): PeerState => ({
  nodeId: 1,
  rssi: -60,
  lastSeen: 0,
  packetsHeard: 1,
  hops: 0,
  ...overrides,
});

describe('summarizeNetworkHealth', () => {
  test('reports an isolated network when no peers are present', () => {
    expect(summarizeNetworkHealth([])).toEqual({
      health: 'isolated',
      directPeers: 0,
      relayedPeers: 0,
      lowBatteryPeers: 0,
    });
  });

  test('distinguishes direct peers from relayed peers', () => {
    expect(
      summarizeNetworkHealth([
        peer({ nodeId: 1, hops: 0 }),
        peer({ nodeId: 2, hops: 2 }),
        peer({ nodeId: 3, hops: 1 }),
      ])
    ).toEqual({
      health: 'connected',
      directPeers: 1,
      relayedPeers: 2,
      lowBatteryPeers: 0,
    });
  });

  test('reports relay connectivity when every peer is reached indirectly', () => {
    expect(summarizeNetworkHealth([peer({ nodeId: 2, hops: 1 })])).toEqual({
      health: 'relay',
      directPeers: 0,
      relayedPeers: 1,
      lowBatteryPeers: 0,
    });
  });

  test('counts known peers at or below 20 percent battery', () => {
    expect(
      summarizeNetworkHealth([
        peer({ nodeId: 1, battery: 20 }),
        peer({ nodeId: 2, battery: 21 }),
        peer({ nodeId: 3, battery: 5 }),
        peer({ nodeId: 4 }),
      ]).lowBatteryPeers
    ).toBe(2);
  });
});
