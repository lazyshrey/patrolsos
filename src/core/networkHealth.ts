import type { PeerState } from '../types';

export type NetworkHealth = 'isolated' | 'relay' | 'connected';

export interface NetworkHealthSummary {
  health: NetworkHealth;
  directPeers: number;
  relayedPeers: number;
  lowBatteryPeers: number;
}

/**
 * Reduces the current peer list to a small, UI-friendly network summary.
 * A relayed peer proves the mesh is still connected, but a direct peer means
 * this phone has a local radio neighbour it can reach without another hop.
 */
export function summarizeNetworkHealth(peers: readonly PeerState[]): NetworkHealthSummary {
  let directPeers = 0;
  let relayedPeers = 0;
  let lowBatteryPeers = 0;

  for (const peer of peers) {
    if (peer.hops === 0) directPeers++;
    else relayedPeers++;

    if (peer.battery != null && peer.battery <= 20) lowBatteryPeers++;
  }

  const health: NetworkHealth =
    directPeers > 0 ? 'connected' : relayedPeers > 0 ? 'relay' : 'isolated';

  return { health, directPeers, relayedPeers, lowBatteryPeers };
}
