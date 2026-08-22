/**
 * In-process transport for laptop testing and the demo fallback.
 *
 * N nodes live in one JS process with an explicit adjacency matrix, so
 * multi-hop relay can be proven without any hardware. Implements the same
 * Transport interface as the real radio, so the engine above it is identical.
 */

import type { PeerState, Transport } from '../types';

interface Node {
  nodeId: number;
  broadcast: Uint8Array[];
  onReceive?: (bytes: Uint8Array, rssi: number) => void;
  onPeer?: (peer: PeerState) => void;
}

export class MockMesh {
  private nodes = new Map<number, Node>();
  /** adjacency[a][b] === true means a can hear b. */
  private links = new Set<string>();
  lossRate = 0;

  link(a: number, b: number): void {
    this.links.add(`${a}:${b}`);
    this.links.add(`${b}:${a}`);
  }

  unlink(a: number, b: number): void {
    this.links.delete(`${a}:${b}`);
    this.links.delete(`${b}:${a}`);
  }

  canHear(listener: number, speaker: number): boolean {
    return this.links.has(`${listener}:${speaker}`);
  }

  register(node: Node): void {
    this.nodes.set(node.nodeId, node);
  }

  unregister(nodeId: number): void {
    this.nodes.delete(nodeId);
  }

  setBroadcast(nodeId: number, packets: Uint8Array[]): void {
    const node = this.nodes.get(nodeId);
    if (node) node.broadcast = packets;
  }

  /**
   * One advertising slot: every node emits its whole rotation to every
   * neighbour. Call repeatedly to let packets ripple outward hop by hop.
   */
  tick(): void {
    const emissions: Array<{ from: number; bytes: Uint8Array }> = [];
    for (const node of this.nodes.values()) {
      for (const bytes of node.broadcast) {
        emissions.push({ from: node.nodeId, bytes });
      }
    }

    for (const { from, bytes } of emissions) {
      for (const listener of this.nodes.values()) {
        if (listener.nodeId === from) continue;
        if (!this.canHear(listener.nodeId, from)) continue;
        if (this.lossRate > 0 && Math.random() < this.lossRate) continue;
        listener.onReceive?.(bytes, -60);
      }
    }
  }

  /** Run `n` slots so packets can traverse several hops. */
  settle(n = 6): void {
    for (let i = 0; i < n; i++) this.tick();
  }
}

export class MockTransport implements Transport {
  private node: Node;

  constructor(private mesh: MockMesh, nodeId: number) {
    this.node = { nodeId, broadcast: [] };
  }

  async start(nodeId: number): Promise<void> {
    this.node.nodeId = nodeId;
    this.mesh.register(this.node);
  }

  async stop(): Promise<void> {
    this.mesh.unregister(this.node.nodeId);
  }

  setBroadcastSet(packets: Uint8Array[]): void {
    this.node.broadcast = packets;
    this.mesh.setBroadcast(this.node.nodeId, packets);
  }

  onReceive(cb: (bytes: Uint8Array, rssi: number) => void): void {
    this.node.onReceive = cb;
  }

  onPeer(cb: (peer: PeerState) => void): void {
    this.node.onPeer = cb;
  }
}
