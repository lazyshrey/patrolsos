# P.A.T.R.O.L. — Implementation Plan
**Peer-to-peer Aid, Tracking, & Remote Offline Link**

A decentralized, offline-first disaster coordination mesh for Android. Zero cellular, zero internet, zero infrastructure.

- **Target:** Android only. 3+ physical devices.
- **Build window:** 4–5 hours.
- **Toolchain (verified present):** Node 22.21, npm 10.9, JDK 17, Android SDK + NDK at `%LOCALAPPDATA%\Android\Sdk`.
- **Root:** `C:\Codes\projects\P.A.T.R.O.L`

---

## 0. The One Big Architectural Decision

**Connectionless BLE advertisement gossip. No GATT. No connections. No pairing.**

Every node continuously advertises a 20-byte binary incident packet in the BLE
manufacturer-specific data field, and simultaneously scans. On hearing an unknown
packet, a node stores it and adds it to its own broadcast rotation with `ttl - 1`.
Epidemic spread emerges from nothing but advertise + scan.

### Why this and not GATT

| Problem with a GATT mesh | Status here |
| --- | --- |
| MTU negotiation (185–512 B) | **Gone** — payload is fixed 20 B |
| Fragmentation + reassembly + retry | **Gone** |
| Connection lifecycle, disconnects, timeouts | **Gone** — connectionless |
| Peripheral GATT server on RN (no good library) | **Gone** — advertise-only |
| Android one-connection-per-device limits | **Gone** — N receivers per broadcast |
| Bonding / pairing dialogs mid-demo | **Gone** |

Legacy BLE advertising gives 31 bytes total: 3 for flags, 2 for the manufacturer-data
header, 2 for company ID, leaving **~24 usable**. Our packet is 20. It fits with
headroom, and a scan response can carry 31 more later if we need them.

**The tradeoff:** no free-text descriptions. We ship a `descPreset` enum of canned
phrases instead. This is a *win* — tapping a preset chip is faster than typing during
an emergency, and it makes deduplication deterministic instead of fuzzy.

### The escape hatch that makes this safe

Everything above the radio is pure TypeScript behind one `Transport` interface with
three implementations. If BLE fights back at hour 3, the product still demos fully.

```ts
interface Transport {
  start(nodeId: number): Promise<void>;
  stop(): Promise<void>;
  setBroadcastSet(packets: Uint8Array[]): void;   // rotation pool
  onReceive(cb: (bytes: Uint8Array, rssi: number) => void): void;
  onPeer(cb: (peer: PeerState) => void): void;
}
```

- `MockTransport` — N nodes in one JS process, adjacency matrix, artificial latency and loss. Runs on the laptop, no devices.
- `BleTransport` — real radio, `react-native-ble-advertiser` + `react-native-ble-plx`.
- `LoopbackTransport` — single-device dev, echoes to self. Five minutes to write, saves an hour of debugging.

---

## 1. Wire Protocol — `PATROL/1`

### 1.1 Packet layout (20 bytes, big-endian)

| Off | Size | Field | Encoding |
| --- | --- | --- | --- |
| 0 | 4 | `packetId` | u32 — first 4 bytes of SHA-256 over the identity tuple, see 1.2 |
| 4 | 4 | `lat` | i32 — degrees x 1e6 (±90.000000, ~11 cm resolution) |
| 8 | 4 | `lon` | i32 — degrees x 1e6 |
| 12 | 1 | `category`:4 / `triage`:4 | two nibbles |
| 13 | 1 | `casualties` | u8, 255 means "many" |
| 14 | 1 | `ttl`:4 / `hops`:4 | ttl starts at 7, hops caps at 15 |
| 15 | 2 | `lamport` | u16 monotonic logical clock |
| 17 | 1 | `status` | u8 lattice ordinal, see 1.4 |
| 18 | 1 | `descPreset` | u8 index into `DESC_PRESETS` |
| 19 | 1 | `originNodeId` | u8 — issuing node, also the LWW tiebreaker |

**Enums**

```
category (u4): 0 MEDICAL  1 WATER  2 FOOD  3 SHELTER
               4 EVACUATION  5 MISSING_PERSON  6 FIRE  7 STRUCTURAL
               8..11 reserved  12 RESOURCE_OFFER  13 DISPATCH  14 GOSSIP_DIGEST  15 reserved
triage   (u4): 0 RED (Immediate)  1 YELLOW (Delayed)  2 GREEN (Minor)  3 BLACK (Deceased)  4 UNKNOWN
status   (u8): 0 REPORTED  1 ACKNOWLEDGED  2 IN_PROGRESS  3 RESOLVED
```

Packet *type* is derived from `category`: 0–7 = `INCIDENT`, 12 = `RESOURCE_OFFER`,
13 = `DISPATCH_ASSIGNMENT`. One codec, no separate type byte. `DISPATCH` packets reuse
`lat`/`lon` as the target incident's coordinates and `casualties` as the assigned team
id — this is how status flows *backward* to the original reporter.

### 1.2 `packetId` — content addressing

```
packetId = sha256(
    round(lat*1e6) || round(lon*1e6) || category || originNodeId || floor(epochMs / 900000)
).slice(0, 4)
```

The 15-minute time bucket means two reports of the same thing from the same node
collapse automatically. Across a few hundred demo packets the u32 collision probability
is negligible. **Do not** include mutable fields (status, casualties, lamport) — the id
must stay stable across updates so updates merge into the right incident.

### 1.3 Rebroadcast suppression — the subtle bug to avoid

> `packetId` alone must **not** gate rebroadcast. A status update carries the *same*
> `packetId` with a higher `lamport`, and would be silently swallowed.

Two distinct structures:

- **`seenSet`** — a bounded LRU `Set<string>` of `packetId:lamport:status`, 2000 entries. Controls *rebroadcast*.
- **`incidentStore`** — keyed by `packetId`. Controls *state*, updated by CRDT merge (1.4).

Receive flow: decode → if in `seenSet`, drop → else add to `seenSet`, merge into
`incidentStore`, and if `ttl > 0` enqueue with `ttl-1, hops+1` into the broadcast rotation.

### 1.4 Conflict resolution — monotonic lattice + LWW

**Status is a totally-ordered monotonic lattice.** Merge is `max()`:

```
REPORTED(0) < ACKNOWLEDGED(1) < IN_PROGRESS(2) < RESOLVED(3)
mergedStatus = Math.max(local.status, remote.status)
```

Conflict-free by construction, needs no clock, and a resolved incident can never regress
to reported regardless of packet delivery order. This is strictly stronger than LWW and
is a genuine pitch point.

**Mutable value fields** (`casualties`, `triage`, `descPreset`) use a Lamport LWW register:

```
if      (remote.lamport >  local.lamport)                                    take remote
else if (remote.lamport === local.lamport && remote.originNodeId > local.originNodeId) take remote
else                                                                         keep local
```

Every local mutation does `lamport = max(localClock, maxSeen) + 1`.
`hops` and `ttl` are transport metadata, never merged — always taken from the packet just received.

### 1.5 Broadcast rotation and duty cycle

Android advertises **one payload at a time**. The engine keeps a priority-ordered
rotation and swaps the advertised payload every **700 ms**.

Priority: RED triage > YELLOW > unresolved > recently-heard > everything else, capped at
the 24 most relevant packets so the full rotation period stays under ~17 s.

Duty cycle (battery — judges will ask): scan **5 s on / 3 s off**; advertise continuously
at `ADVERTISE_MODE_LOW_LATENCY` / `TX_POWER_HIGH` for the demo, with a documented
`BALANCED` / `MEDIUM` production profile.

### 1.6 Store garbage collection

Unbounded epidemic gossip fills storage. Eviction runs every 60 s:

- Drop `RESOLVED` incidents older than 30 minutes.
- Hard cap of 5 000 rows; evict lowest priority first.
- **Never evict RED triage or unresolved MEDICAL.**

---

## 2. Deduplication — geo-semantic clustering

Levenshtein over panic text is unreliable, and we have no free text anyway. Deterministic instead.

**Candidate key:** `geohash6(lat, lon)` (≈1.2 km cell) — a cheap SQLite prefix index.

**Merge test**, all three must hold:

1. `haversine(a, b) <= 150 m`
2. `a.category === b.category`
3. `|a.firstSeen - b.firstSeen| <= 15 min`

Neighbouring-cell edge case: also query the 8 surrounding geohash6 cells, otherwise two
reports 20 m apart that straddle a cell boundary never get compared. (`geohashNeighbors()`.)

**Cluster representative:**

- location — casualty-count-weighted centroid
- triage — the **most severe** member (never average severity downward)
- casualties — `max` of members, not sum (it is one event double-reported)
- status — `max` of members (lattice)
- `reportCount` — member count, drives the confidence ring on the map

The visual payoff: six pins collapsing into one labelled cluster is the most legible
thing in the whole demo. Build the animation.

---

## 3. Resource Matching

```
severityWeight = { RED: 100, YELLOW: 40, GREEN: 10, BLACK: 1 }
decay          = clamp(1 + ageMinutes / 30, 1, 3)        // older unserved = more urgent

score(incident, resource) =
    severityWeight[triage] * max(casualties, 1) * decay
    / (haversineKm(incident, resource) + 1)
```

**Greedy, not bipartite.** Sort every (incident x capable resource) pair by score
descending, assign, mark both consumed, repeat. O(n·m log nm), about 30 lines, correct
enough, and explainable to a judge in one sentence. The Hungarian algorithm is a trap here.

Capability gate: a resource only matches categories it serves — `MEDIC → MEDICAL, EVACUATION`;
`WATER_TRUCK → WATER`; `BOAT → EVACUATION, MISSING_PERSON`; and so on.

Dispatch emits a `DISPATCH` packet (category 13) that gossips **backward** through the
mesh to the original reporter. **This is the differentiator — lead the pitch with it.**

---

## 4. File Tree

```
P.A.T.R.O.L/
├── PLAN.md                      # this file
├── README.md                    # judge-facing: architecture, protocol, run steps
├── app.config.ts                # expo config plugin: permissions + BLE
├── package.json / tsconfig.json
├── App.tsx                      # role switcher + tab shell
├── android/                     # generated by `expo prebuild` — do not hand-edit
├── src/
│   ├── types/
│   │   ├── incident.ts          # Incident, Triage, Category, Coords, Status
│   │   ├── mesh.ts              # Packet, PeerState, Transport interface
│   │   └── resource.ts          # Resource, Dispatch, Capability
│   ├── proto/
│   │   ├── codec.ts             # encode/decode the 20-byte packet  <- unit tested first
│   │   ├── packetId.ts          # SHA-256 content addressing
│   │   └── presets.ts           # DESC_PRESETS
│   ├── core/                    # 100% pure TS, zero RN imports, laptop-testable
│   │   ├── meshEngine.ts        # gossip, seenSet, TTL, rotation, GC
│   │   ├── crdt.ts              # status lattice + Lamport LWW merge
│   │   ├── deduplicator.ts      # geohash + haversine clustering
│   │   ├── geo.ts               # haversine, geohash encode/neighbors
│   │   ├── triageEngine.ts      # S.T.A.R.T. scoring + priority ordering
│   │   └── resourceMatcher.ts   # greedy scorer + dispatch builder
│   ├── transport/
│   │   ├── index.ts             # Transport interface + runtime selector
│   │   ├── MockTransport.ts     # in-process N-node sim (adjacency + loss + latency)
│   │   ├── LoopbackTransport.ts # single-device echo
│   │   └── BleTransport.ts      # ble-advertiser + ble-plx
│   ├── services/
│   │   ├── storage.ts           # expo-sqlite: incidents, packets, resources, log
│   │   ├── locationService.ts   # expo-location, BestForNavigation, satellite-only
│   │   └── nodeIdentity.ts      # persistent u8 nodeId + display callsign
│   ├── state/
│   │   └── store.ts             # zustand: incidents, peers, resources, role, log
│   ├── screens/
│   │   ├── ReportScreen.tsx     # 3-tap triage capture
│   │   ├── IncidentListScreen.tsx
│   │   ├── CommandMapScreen.tsx # SVG plot, NOT react-native-maps
│   │   ├── ResourceScreen.tsx
│   │   └── MeshScreen.tsx       # peer topology + live packet tracer
│   ├── components/
│   │   ├── TriagePicker.tsx   CategoryGrid.tsx   IncidentCard.tsx
│   │   ├── MeshGraph.tsx      PacketTicker.tsx   StatusPill.tsx
│   │   └── RoleSwitcherBar.tsx
│   └── mock/
│       └── disasterPreset.ts    # seeded scenario: 12 incidents, 6 resources, 4 nodes
└── __tests__/
    ├── codec.test.ts            # roundtrip, boundary lat/lon, nibble packing
    ├── crdt.test.ts             # lattice monotonicity, LWW tiebreak, out-of-order
    ├── gossip.test.ts           # 3-node multi-hop, loop suppression, TTL exhaustion
    ├── dedup.test.ts            # cluster merge, cell-boundary case, non-merge
    └── matcher.test.ts          # priority ordering, capability gate, greedy assign
```

**Rule:** nothing in `src/core/` or `src/proto/` may import from `react-native`. That is
what makes the whole engine testable with jest on the laptop in seconds, with no device
and no Android build in the loop.

---

## 5. Map — do NOT use `react-native-maps`

Google and Apple tiles require internet. Our entire premise is *no internet*. A demo map
showing grey squares kills the pitch.

**Ship instead:** a `react-native-svg` tactical plot. Equirectangular projection of
lat/lon into viewport coordinates, auto-fitting bounds to the incident set, over a
bundled static satellite PNG of the demo area with known corner coordinates. Pinch-zoom
and pan via `react-native-gesture-handler`. Renders triage-coloured pins, GPS accuracy
circles, cluster rings sized by `reportCount`, and dashed dispatch lines from resource
to target.

Cost: about 45 minutes. Genuinely offline. Reads more "tactical ops" than a consumer
map, which suits the pitch better anyway.

---

## 6. Android Permissions (`app.config.ts` → generated manifest)

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
                 android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.BLUETOOTH"       android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
<uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
```

**Runtime gotchas that eat 30 minutes if unanticipated:**

- Android 12+ needs `BLUETOOTH_SCAN` / `ADVERTISE` / `CONNECT` requested at **runtime**, not just manifested.
- Many OEM builds still require **Location Services toggled ON** for BLE scan to return results, even with `neverForLocation`. Build a preflight screen that checks this and says so plainly.
- Not every chipset supports BLE peripheral advertising. Call `BluetoothAdapter.isMultipleAdvertisementSupported()` on boot and surface it in the Mesh screen. **Verify all 3 phones early — this is a hard gate.** Almost all post-2018 devices are fine, but confirm rather than assume.
- Use company ID `0xFFFF` (reserved for testing) in the manufacturer data and filter scans on it, so we ignore every unrelated beacon in the room.

---

## 7. Dependencies

```
expo, react-native, typescript, @types/react
expo-location                 # satellite GPS, works with zero cellular data
expo-sqlite                   # indexed store; AsyncStorage will NOT scale to a gossip log
expo-crypto                   # SHA-256 (React Native has no crypto.subtle)
react-native-ble-plx          # central / scanning
react-native-ble-advertiser   # peripheral / advertising (Android)
react-native-svg              # tactical map
react-native-gesture-handler, react-native-reanimated
zustand                       # state; Context will re-render the map to death
jest, ts-jest                 # core tests, laptop-only
```

Versions get pinned by `npx expo install` at install time so they match the Expo SDK.

---

## 8. Hour-by-Hour Execution

| Time | Work | Gate |
| --- | --- | --- |
| **0:00–0:20** | `create-expo-app` → TS → `expo prebuild` → **kick off the first `run:android` in the background.** Write `app.config.ts` permissions while gradle downloads. | Build running, terminal free |
| **0:20–1:15** | `types/`, `proto/codec.ts`, `core/*` — pure TS. Jest tests for codec roundtrip, CRDT merge, 3-node gossip, dedup, matcher. **No UI yet.** | `npm test` green |
| **1:15–2:15** | `MockTransport` + zustand store + all five screens. Full 3-virtual-node flow: report → relay → HQ → dispatch → status returns to reporter. | **Complete product demoable on the laptop** |
| **2:15–3:15** | `BleTransport`. Advertiser rotation and scan parsing. Install on all 3 phones. | Two phones exchange one real packet |
| **3:15–4:00** | 3-device multi-hop (Nodes 1 and 3 out of range, Node 2 relays). SVG map polish, mesh visualizer, disaster preset seeding. | Multi-hop confirmed on hardware |
| **4:00–4:30** | `README.md`, demo run-sheet, screenshots, buffer. | Shippable |

**Hard gate at 3:15.** If BLE has not passed a single real packet by then, freeze it,
flip the transport selector to `MockTransport`, and demo the complete product on three
phones each running an independent simulated mesh. The product is unchanged; only the
radio is stubbed. Say so honestly in the pitch — an isolated, swappable radio layer is
an architecture strength, not an excuse.

---

## 9. Verification

**Automated (laptop, no devices):**

1. **Codec** — roundtrip 10 000 random packets; boundary lat/lon (±90, ±180, 0/0); nibble packing does not bleed across fields.
2. **CRDT** — status never regresses across all 24 permutations of four status packets; LWW tiebreaks by `originNodeId` at equal `lamport`.
3. **Gossip** — a 3-node line topology delivers 1→3 with no direct link; no node rebroadcasts the same packet twice; `ttl = 0` terminates; a 5-node ring does not loop forever.
4. **Dedup** — six reports within 150 m, same category, within 15 min → exactly one cluster; a report 200 m away stays separate; the geohash cell-boundary case merges correctly.
5. **Matcher** — RED before YELLOW at equal distance; nearer wins at equal severity; a `WATER_TRUCK` is never assigned to a `MEDICAL` incident.

**Manual (3 phones):**

1. GPS captured with lat/lon/accuracy in airplane mode, Wi-Fi and cellular fully off.
2. Node 1 → Node 2 → Node 3 relay with 1 and 3 physically separated beyond BLE range.
3. HQ (Node 3) assigns a team and sets `IN_PROGRESS`; **Node 1 shows the status change** without ever seeing Node 3.
4. Kill Node 2 mid-flight; confirm Nodes 1 and 3 stop converging, then restore it and confirm anti-entropy catches up.

---

## 10. Explicitly Cut (state these as deliberate scope, not gaps)

| Cut | Why | Cost to add later |
| --- | --- | --- |
| Wi-Fi Direct | Android-only anyway; advertisement gossip carries our payload fine | 4 h |
| iOS | No Wi-Fi Direct API; crippled background BLE advertising | 8 h+ |
| Ed25519 packet signing | 20 B leaves no room for a 64 B signature | Needs GATT or a v2 packet |
| Free-text descriptions | Preset chips are faster under stress and make dedup deterministic | v2 packet |
| MapLibre / PMTiles | The SVG plot is offline and 4x faster to build | 3 h |
| Bipartite / Hungarian matching | Greedy is sufficient and explainable | 2 h |
| Encryption at rest | Not a judged criterion | 1 h |

**Known limitation to volunteer before a judge finds it:** unsigned packets mean a
malicious node could inject false incidents. The mitigation is a v2 packet over a GATT
channel carrying Ed25519 signatures; the 20-byte advertisement format is a deliberate
trade of authenticity for reach and simplicity in the first 72 hours. Naming this
yourself reads as engineering maturity.

---

## 11. Demo Run-Sheet (90 seconds)

1. **All three phones in airplane mode, Bluetooth on.** Hold them up. "No cell. No Wi-Fi. No internet."
2. Phone A (Survivor): three taps — MEDICAL, RED, 4 casualties. GPS captured from satellite.
3. Phone C (HQ) is **across the room, out of range of A**. Phone B sits between them.
4. Watch the Mesh screen on B: the packet arrives at `ttl 7 → 6` and rebroadcasts.
5. Phone C receives it. `hops: 2`. Pin drops on the tactical map.
6. Two more survivors report the same event — **the three pins visibly collapse into one cluster.**
7. HQ taps Auto-Match. Rescue Team Alpha, 0.4 km. Dispatch.
8. **Phone A lights up: "Team Alpha en route — IN PROGRESS."** It never saw Phone C.
9. Close on that. Step 8 is the whole pitch.
