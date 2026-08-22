/**
 * "If you walk away, these people lose contact."
 *
 * A mesh made of phones has a failure mode nobody warns you about: one person
 * wanders off and two groups that were talking to each other go silent. The
 * person who left never knows they were the link.
 *
 * We can detect it, because OBSERVATION packets already tell us who hears whom.
 * Each observation is an edge in a partial view of the network graph. Remove
 * ourselves from that graph and ask whether our direct neighbours are still
 * connected to each other. If they split into separate groups, we are the only
 * thing joining them — an articulation point, in graph terms.
 *
 * HONESTY ABOUT WHAT THIS KNOWS
 * -----------------------------
 * The graph is partial. We only know about links somebody has told us about, so
 * we can miss an edge and cry wolf. We therefore warn only when the evidence is
 * reasonably strong, and the wording says "may lose contact", never "will".
 * A false warning costs someone a moment's hesitation; a missed one costs
 * contact with a group of people.
 */

import type { Observation } from './localization';
import type { PeerState } from '../types';

/** Below this signal we do not treat a link as dependable evidence. */
const USABLE_RSSI = -92;

export interface BridgeStatus {
  /** True when removing this node would split its neighbours apart. */
  isBridge: boolean;
  /** The groups that would be left unable to reach each other. */
  groups: number[][];
  /** Nodes that would be cut off entirely — no route to anyone else. */
  isolated: number[];
}

export type Graph = Map<number, Set<number>>;

function addEdge(g: Graph, a: number, b: number): void {
  if (a === b) return;
  if (!g.has(a)) g.set(a, new Set());
  if (!g.has(b)) g.set(b, new Set());
  g.get(a)!.add(b);
  g.get(b)!.add(a);
}

/**
 * Build what we know of the network.
 *
 * Two sources of edges:
 *   - our own direct peers: we hear them, so there is an edge to us
 *   - observations: "X heard Y" is an edge between X and Y
 */
export function buildGraph(
  selfNodeId: number,
  peers: PeerState[],
  observations: Observation[]
): Graph {
  const g: Graph = new Map();
  g.set(selfNodeId, new Set());

  for (const p of peers) {
    if (p.hops === 0) addEdge(g, selfNodeId, p.nodeId);
  }

  for (const o of observations) {
    if (o.rssi < USABLE_RSSI) continue;
    addEdge(g, o.observerNodeId, o.targetNodeId);
  }

  return g;
}

/** Connected components of `graph`, ignoring `without`. */
function components(graph: Graph, without: number): number[][] {
  const seen = new Set<number>([without]);
  const out: number[][] = [];

  for (const start of graph.keys()) {
    if (seen.has(start)) continue;

    const group: number[] = [];
    const stack = [start];
    seen.add(start);

    while (stack.length > 0) {
      const node = stack.pop()!;
      group.push(node);
      for (const next of graph.get(node) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    out.push(group.sort((a, b) => a - b));
  }

  return out;
}

export function analyseBridge(
  selfNodeId: number,
  peers: PeerState[],
  observations: Observation[]
): BridgeStatus {
  const graph = buildGraph(selfNodeId, peers, observations);
  const direct = [...(graph.get(selfNodeId) ?? [])];

  // With fewer than two direct neighbours you cannot be between anyone.
  if (direct.length < 2) {
    return { isBridge: false, groups: [], isolated: [] };
  }

  const groups = components(graph, selfNodeId);

  // Only the groups our own neighbours land in matter. A group we are not
  // attached to was never ours to disconnect.
  const relevant = groups.filter((g) => g.some((n) => direct.includes(n)));

  if (relevant.length < 2) {
    return { isBridge: false, groups: [], isolated: [] };
  }

  return {
    isBridge: true,
    groups: relevant,
    isolated: relevant.filter((g) => g.length === 1).flat(),
  };
}

/** Plain-language warning, or null when there is nothing to say. */
export function bridgeMessage(status: BridgeStatus): string | null {
  if (!status.isBridge) return null;

  const people = status.groups.reduce((n, g) => n + g.length, 0);
  const groupCount = status.groups.length;

  if (groupCount === 2 && status.isolated.length === 1) {
    return 'One phone can only reach the others through you. Stay in range if you can.';
  }

  return `${people} phones in ${groupCount} groups may lose contact with each other if you move away.`;
}
