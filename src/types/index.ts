/**
 * P.A.T.R.O.L. core type contracts.
 *
 * Pure TypeScript. Nothing in src/types, src/proto or src/core may import from
 * react-native or expo-* — that is what keeps the engine testable on a laptop
 * with no device and no Android build in the loop.
 */

// ---------------------------------------------------------------------------
// Enums (const objects, not TS `enum` — better tree-shaking and JSON safety)
// ---------------------------------------------------------------------------

/** Wire values 0-7 are incidents; 12-14 are control packets. Fits in a nibble. */
export const Category = {
  MEDICAL: 0,
  WATER: 1,
  FOOD: 2,
  SHELTER: 3,
  EVACUATION: 4,
  MISSING: 5,
  FIRE: 6,
  STRUCTURAL: 7,
  /**
   * "I am here." Carries the sender's own GPS position rather than an incident.
   * Reuses the exact same 20-byte frame — lat/lon are the node's coordinates and
   * originNodeId identifies it — so peer positions cost no new wire format.
   * Broadcast on a low TTL: only nearby nodes care where you are.
   */
  PRESENCE: 8,
  /**
   * "I heard node Y at signal strength Z, and I was standing here."
   *
   * The raw material for locating a phone that has no GPS fix of its own.
   * Reuses the same 20-byte frame: lat/lon are the OBSERVER's position,
   * originNodeId is the observer, casualties carries the target's node id and
   * descPreset carries the RSSI magnitude.
   */
  OBSERVATION: 9,
  /**
   * "Ring." A locate ping: every phone it names starts a loud alarm and
   * answers with where it is.
   *
   * Same 20-byte frame: lat/lon are the CALLER's position, originNodeId is the
   * caller, casualties carries the target node id (BUZZ_ALL = everyone) and
   * descPreset carries how many seconds to ring for. The caller's lamport is
   * the press id, so hearing the same press ten times still rings once.
   */
  BUZZ: 10,
  /**
   * "I am ringing, and this is where I am." The answer to a BUZZ.
   *
   * lat/lon are the RESPONDER's own position, originNodeId is the responder,
   * casualties carries the node id that rang them and descPreset carries their
   * battery percentage.
   */
  BUZZ_ACK: 11,
  RESOURCE_OFFER: 12,
  DISPATCH: 13,
  GOSSIP_DIGEST: 14,
} as const;
export type Category = (typeof Category)[keyof typeof Category];

/** S.T.A.R.T. triage. UI says "Now / Soon / Can wait" — this is the protocol. */
export const Triage = {
  RED: 0, // Immediate
  YELLOW: 1, // Delayed
  GREEN: 2, // Minor
  BLACK: 3, // Deceased
  UNKNOWN: 4,
} as const;
export type Triage = (typeof Triage)[keyof typeof Triage];

/**
 * Totally-ordered monotonic lattice. Merge is Math.max, so a resolved incident
 * can never regress no matter what order the mesh delivers packets in.
 */
export const Status = {
  REPORTED: 0,
  ACKNOWLEDGED: 1,
  IN_PROGRESS: 2,
  RESOLVED: 3,
} as const;
export type Status = (typeof Status)[keyof typeof Status];

// ---------------------------------------------------------------------------
// Wire packet — exactly the 20 bytes, nothing more
// ---------------------------------------------------------------------------

export interface Packet {
  /** u32, first 4 bytes of SHA-256 over the identity tuple. Stable across updates. */
  packetId: number;
  /** Decoded degrees. On the wire these are i32 fixed-point at 1e6. */
  lat: number;
  lon: number;
  category: Category;
  triage: Triage;
  /** u8. 255 means "many". */
  casualties: number;
  /** u4, starts at 7, decremented on each relay. */
  ttl: number;
  /** u4, incremented on each relay, caps at 15. */
  hops: number;
  /** u16 monotonic logical clock. */
  lamport: number;
  status: Status;
  /** u8 index into DESC_PRESETS. */
  descPreset: number;
  /** u8, issuing node. Also the LWW tiebreaker. */
  originNodeId: number;
}

// ---------------------------------------------------------------------------
// Stored / merged shape
// ---------------------------------------------------------------------------

export interface Incident {
  packetId: number;
  lat: number;
  lon: number;
  category: Category;
  triage: Triage;
  casualties: number;
  status: Status;
  lamport: number;
  descPreset: number;
  originNodeId: number;
  /** Local wall-clock bookkeeping — never travels on the wire. */
  firstSeen: number;
  lastSeen: number;
  hops: number;
  /** How many distinct reports the deduplicator merged into this one. */
  reportCount: number;
  /** True when this node originated the report (drives "your report" UI). */
  mine: boolean;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface PeerState {
  nodeId: number;
  rssi: number;
  lastSeen: number;
  packetsHeard: number;
  /** From that peer's PRESENCE packets. Undefined until one arrives. */
  lat?: number;
  lon?: number;
  /** 0 = heard directly off the radio; higher = reached through a relay. */
  hops: number;
  /** Battery percentage from that peer's presence packets, if it has shared one. */
  battery?: number;
  /** Last time we heard this peer with hops === 0, i.e. straight off the radio. */
  lastDirectAt?: number;
  /**
   * Lamport clock of the newest presence packet we accepted from this peer.
   * Guards against a slow relayed copy dragging their position backwards.
   */
  presenceLamport?: number;
  /** Set while this peer is answering a buzz, i.e. its alarm is sounding. */
  ringingUntil?: number;
}

export type PacketDirection = 'rx' | 'tx' | 'drop' | 'merge';

export interface PacketEvent {
  at: number;
  dir: PacketDirection;
  packetId: number;
  note: string;
}

export interface Transport {
  start(nodeId: number): Promise<void>;
  stop(): Promise<void>;
  /** Replaces the rotation pool the radio cycles through. */
  setBroadcastSet(packets: Uint8Array[]): void;
  onReceive(cb: (bytes: Uint8Array, rssi: number) => void): void;
  onPeer(cb: (peer: PeerState) => void): void;
}
