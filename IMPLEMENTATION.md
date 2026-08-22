# P.A.T.R.O.L. — Implementation & Workflow Plan

Companion to [PLAN.md](PLAN.md). That document decides *what* and *why*.
This one is the build manual: setup commands, task breakdown, file-by-file order,
and the day-of workflow.

**Stack:** Expo (bare/prebuild) · React Native · TypeScript · **NativeWind v4 + Tailwind CSS 3** · zustand · expo-sqlite · react-native-svg · react-native-ble-plx + react-native-ble-advertiser

---

## Table of Contents

- [A. Ground Rules](#a-ground-rules-read-once-obey-all-day)
- [B. Phase 0 — Setup](#b-phase-0--setup-020)
- [C. Design System](#c-design-system-tailwind-tokens)
- [D. Task Breakdown](#d-task-breakdown)
- [E. Dependency Graph](#e-dependency-graph--critical-path)
- [F. Development Workflow](#f-development-workflow)
- [G. Definition of Done](#g-definition-of-done)

---

## A. Ground Rules (read once, obey all day)

These five rules are what keep a 4-hour build from collapsing at hour 3.

1. **Layer purity.** `src/proto/` and `src/core/` import *nothing* from `react-native`,
   `expo-*`, or any UI library. Pure TypeScript, pure functions, no I/O. This is what
   lets the entire engine be tested with jest on the laptop in ~2 seconds while gradle
   is still downloading.

2. **One export per concern.** Every file has a single clear responsibility and a named
   export. No barrel files re-exporting the world except `src/types/index.ts`.

3. **Dependencies point downward only.**
   `screens → components → state → services → core → proto → types`
   Never upward, never sideways between siblings. If you need to go up, you need a
   callback parameter instead.

4. **Style with NativeWind `className` only.** No `StyleSheet.create`, no inline `style`
   objects, with two allowed exceptions: dynamic transform values in the SVG map, and
   animated styles under Reanimated.

5. **Commit at every green gate.** Each task below ends in a checkable state. Commit
   there. When something breaks at 3am you want a working commit 15 minutes back, not
   90.

---

## B. Phase 0 — Setup (0:00–0:20)

Run these in order. Total wall time ~6 minutes of typing, then a background build.

### B.1 Scaffold

```bash
npx create-expo-app@latest . --template blank-typescript
```

If the directory is non-empty (PLAN.md is here), scaffold into a temp folder and move
the contents in, or pass `--yes` and merge. Keep `PLAN.md` and `IMPLEMENTATION.md`.

### B.2 Core dependencies

```bash
npx expo install expo-location expo-sqlite expo-crypto react-native-svg react-native-gesture-handler react-native-reanimated react-native-safe-area-context react-native-screens
```

```bash
npm install zustand
```

### B.3 NativeWind v4 + Tailwind

> **Critical:** NativeWind v4 requires **Tailwind CSS v3**, not v4. Installing
> `tailwindcss@latest` pulls v4 and the build fails with an opaque PostCSS error.
> Pin it.

```bash
npx expo install nativewind
```

```bash
npm install -D tailwindcss@3.4.17 prettier-plugin-tailwindcss
```

**`tailwind.config.js`** — note the `presets` line; without it, nothing works:

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: { extend: { /* see section C */ } },
  plugins: [],
};
```

**`global.css`** (project root):

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**`babel.config.js`**:

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: ['react-native-reanimated/plugin'], // MUST be last
  };
};
```

**`metro.config.js`**:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);
module.exports = withNativeWind(config, { input: './global.css' });
```

**`nativewind-env.d.ts`** (project root) — gives `className` type support:

```ts
/// <reference types="nativewind/types" />
```

**`App.tsx`** — first line of the entry file:

```ts
import './global.css';
```

### B.4 BLE modules

```bash
npx expo install react-native-ble-plx
```

```bash
npm install react-native-ble-advertiser
```

### B.5 Testing

```bash
npm install -D jest @types/jest ts-jest
```

**`jest.config.js`** — scoped to pure layers only, so tests never touch React Native:

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  roots: ['<rootDir>/__tests__', '<rootDir>/src'],
};
```

Add to `package.json`: `"test": "jest"`, `"test:watch": "jest --watch"`.

### B.6 `app.config.ts`

Replace `app.json` with `app.config.ts` and add the Android permissions block from
[PLAN.md §6](PLAN.md), plus the BLE plugin config:

```ts
plugins: [
  ['react-native-ble-plx', { isBackgroundEnabled: true, modes: ['peripheral', 'central'] }],
  'expo-location',
]
```

### B.7 Prebuild + first build (background)

```bash
npx expo prebuild --platform android --clean
```

Then start the Android build **in the background** and immediately go write code —
the first gradle run takes 8–15 minutes and you must not sit idle for it:

```bash
npx expo run:android
```

### ✅ Phase 0 gate

- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` runs (0 tests is fine)
- [ ] Gradle build is running in a background terminal
- [ ] `git init && git add -A && git commit -m "chore: scaffold"`

---

## C. Design System (Tailwind tokens)

Define these once in `tailwind.config.js` so triage colours are consistent everywhere
and the map, list, and pills can never drift apart.

```js
theme: {
  extend: {
    colors: {
      // S.T.A.R.T. triage — these are protocol, not decoration
      triage: {
        red:    '#DC2626',  // Immediate
        yellow: '#F59E0B',  // Delayed
        green:  '#16A34A',  // Minor
        black:  '#1F2937',  // Deceased
        unknown:'#6B7280',
      },
      // Tactical dark UI — readable in daylight, low battery draw on OLED
      ops: {
        bg:      '#0B0F14',
        surface: '#141A21',
        border:  '#243040',
        text:    '#E6EDF3',
        muted:   '#8B98A5',
        accent:  '#22D3EE',  // mesh / packet activity
        warn:    '#F59E0B',
      },
    },
    fontFamily: { mono: ['monospace'] },  // packet IDs, coordinates, hop counts
  },
}
```

**Conventions:**

- Screens are `bg-ops-bg`, cards are `bg-ops-surface border border-ops-border rounded-2xl`.
- Anything that is a coordinate, packet id, hop count, or timestamp renders `font-mono text-ops-muted`.
- Triage colour is applied via a single helper `triageClass(t)` in `src/theme/triage.ts` returning
  e.g. `'bg-triage-red'` — never hard-code a hex in a component.
- **Touch targets minimum `h-14`.** This is a disaster app used with shaking hands.

### NativeWind + SVG caveat

`react-native-svg` primitives do not accept `className` out of the box. In
`src/theme/cssInterop.ts`, register them once:

```ts
import { cssInterop } from 'nativewind';
import { Circle, Path, Rect, G, Text as SvgText } from 'react-native-svg';
[Circle, Path, Rect, G, SvgText].forEach((C) =>
  cssInterop(C, { className: { target: false, nativeStyleToProp: { fill: true, stroke: true } } })
);
```

Simpler alternative if this fights back: pass hex values from `src/theme/colors.ts` as
plain `fill`/`stroke` props inside the map only. Do not burn more than 10 minutes here.

---

## D. Task Breakdown

Each task lists its files, subtasks, and a **DoD** (definition of done) that is
objectively checkable. Work strictly top to bottom.

---

### Phase 1 — Protocol & Types (0:20–0:50) · pure TS, no device needed

#### T1.1 — Type contracts
**Files:** `src/types/incident.ts`, `src/types/mesh.ts`, `src/types/resource.ts`, `src/types/index.ts`

- [ ] `Category`, `Triage`, `IncidentStatus` as const-object enums (not TS `enum` — better tree-shaking and JSON safety)
- [ ] `Coords { lat; lon; accuracy?; altitude?; timestamp }`
- [ ] `Incident` — the merged/stored shape: `packetId, coords, category, triage, casualties, status, lamport, originNodeId, descPreset, firstSeen, lastSeen, hops, reportCount, clusterId?`
- [ ] `Packet` — the decoded wire shape (exactly the 20-byte fields, nothing more)
- [ ] `PeerState { nodeId; rssi; lastSeen; packetsHeard }`
- [ ] `Transport` interface verbatim from PLAN.md §0
- [ ] `Resource { id; kind; capabilities: Category[]; coords; quantity; available }`, `Dispatch`

**DoD:** `npx tsc --noEmit` clean. No runtime code in this folder.

#### T1.2 — Presets table
**File:** `src/proto/presets.ts`

- [ ] `DESC_PRESETS: readonly string[]` — up to 64 canned phrases, grouped by category
- [ ] `PRESETS_BY_CATEGORY: Record<Category, number[]>` so the UI shows only relevant chips
- [ ] Index 0 reserved as `"Unspecified"`

**DoD:** every index < 64; every category has ≥ 4 presets.

#### T1.3 — Packet ID
**File:** `src/proto/packetId.ts`

- [ ] `computePacketId(lat, lon, category, originNodeId, epochMs): number` per PLAN.md §1.2
- [ ] Takes an injected `sha256: (b: Uint8Array) => Uint8Array` so core stays pure and jest can use Node's `crypto`
- [ ] 15-minute bucket: `Math.floor(epochMs / 900_000)`
- [ ] Returns u32 from the first 4 bytes, big-endian

**DoD:** same inputs → same id; a 16-minute gap → different id; a 1-minute gap in the same bucket → same id.

#### T1.4 — Codec ⭐ *the highest-risk pure module*
**File:** `src/proto/codec.ts`

- [ ] `encodePacket(p: Packet): Uint8Array` — exactly 20 bytes
- [ ] `decodePacket(b: Uint8Array): Packet | null` — returns `null` on wrong length, unknown version, or out-of-range values (never throws; a malformed advert must not crash a node)
- [ ] Fixed-point helpers `latToI32` / `i32ToLat` with `Math.round`, clamped to ±90 / ±180
- [ ] Nibble pack/unpack helpers, unit-tested independently
- [ ] `MANUFACTURER_ID = 0xFFFF` exported here

**DoD:** `__tests__/codec.test.ts` green — 10 000 random roundtrips, boundary coords (±90, ±180, 0/0), truncated/oversized buffers return `null`, nibbles do not bleed.

> Do not proceed until this test passes. Every later bug will masquerade as a codec bug otherwise.

---

### Phase 2 — Core Engine (0:50–1:15) · pure TS

#### T2.1 — Geo primitives
**File:** `src/core/geo.ts`

- [ ] `haversineMeters(a, b)`
- [ ] `geohashEncode(lat, lon, precision)` (base32)
- [ ] `geohashNeighbors(hash): string[8]` — **required**, see PLAN.md §2 cell-boundary case
- [ ] `weightedCentroid(points, weights)`

**DoD:** known-distance fixture within 0.5%; neighbours of a known hash match reference values.

#### T2.2 — CRDT merge
**File:** `src/core/crdt.ts`

- [ ] `mergeStatus(a, b) = Math.max(a, b)` — the monotonic lattice
- [ ] `mergeIncident(local, remote): Incident` — lattice for status, Lamport LWW (tiebreak on `originNodeId`) for `casualties`/`triage`/`descPreset`
- [ ] `nextLamport(localClock, seenMax) = Math.max(localClock, seenMax) + 1`
- [ ] `hops`/`ttl` always taken from the incoming packet, never merged

**DoD:** `crdt.test.ts` — all 24 permutations of four status packets converge to the same final state and never regress.

#### T2.3 — Mesh engine ⭐
**File:** `src/core/meshEngine.ts`

- [ ] `class MeshEngine` — constructor takes `{ nodeId, transport, now, onChange }` (inject `now()` so tests control time)
- [ ] `seenSet` — bounded LRU keyed `packetId:lamport:status`, cap 2000 (**PLAN.md §1.3 — do not key on packetId alone**)
- [ ] `incidentStore: Map<number, Incident>` merged via `mergeIncident`
- [ ] `onReceive` pipeline: decode → seen? drop : mark → merge → `ttl>0` ? enqueue(ttl-1, hops+1) : drop
- [ ] `broadcastRotation` — priority sort (RED > YELLOW > unresolved > recent), cap 24, `tick()` advances one slot
- [ ] `originate(partial): Packet` — stamps lamport, packetId, ttl=7, hops=0
- [ ] `gc()` — PLAN.md §1.6 rules; never evicts RED or unresolved MEDICAL
- [ ] Emits a `PacketEvent` log line for every send/receive/drop → feeds the Mesh screen ticker

**DoD:** `gossip.test.ts` — 3-node line delivers 1→3 with no direct link; no double rebroadcast; `ttl=0` terminates; a 5-node ring converges and halts.

#### T2.4 — Deduplicator
**File:** `src/core/deduplicator.ts`

- [ ] `clusterIncidents(incidents): Cluster[]` per PLAN.md §2
- [ ] Bucket by `geohash6`, expand candidate set with the 8 neighbours
- [ ] Merge test: ≤150 m AND same category AND within 15 min
- [ ] Representative: weighted centroid, **most severe** triage, `max` casualties, `max` status, `reportCount`

**DoD:** `dedup.test.ts` — 6 co-located reports → 1 cluster; a 200 m outlier stays separate; the cell-boundary pair merges.

#### T2.5 — Triage + Matcher
**Files:** `src/core/triageEngine.ts`, `src/core/resourceMatcher.ts`

- [ ] `severityWeight`, `urgencyDecay(ageMinutes)`, `priorityScore(incident)`
- [ ] `matchResources(clusters, resources): Dispatch[]` — greedy, capability-gated, per PLAN.md §3
- [ ] `buildDispatchPacket(dispatch)` — category 13, coords = target, `casualties` field = team id

**DoD:** `matcher.test.ts` — RED before YELLOW at equal distance; nearer wins at equal severity; a `WATER_TRUCK` never lands on a `MEDICAL` incident.

### ✅ Phase 2 gate — **`npm test` fully green. The entire product logic is proven with zero devices.** Commit.

---

### Phase 3 — Transport & Services (1:15–1:40)

#### T3.1 — MockTransport
**File:** `src/transport/MockTransport.ts`

- [ ] Static in-process registry of nodes + an adjacency matrix
- [ ] `setTopology(matrix)` — the demo default is a line: `1↔2↔3`, with `1` and `3` unlinked
- [ ] Configurable latency (default 200 ms) and packet loss (default 5%)
- [ ] Implements `Transport` exactly

**DoD:** three `MeshEngine`s over `MockTransport` reproduce the T2.3 multi-hop result at runtime, not just in tests.

#### T3.2 — Storage
**File:** `src/services/storage.ts`

- [ ] `expo-sqlite` schema: `incidents`, `packets_log`, `resources`, `dispatches`
- [ ] Index on `geohash6` and on `lastSeen`
- [ ] `upsertIncident`, `loadAll`, `appendLog`, `evict` — all async, all typed
- [ ] Graceful no-op fallback if SQLite is unavailable, so the laptop/web preview still runs

**DoD:** app restart preserves incidents.

#### T3.3 — Location & identity
**Files:** `src/services/locationService.ts`, `src/services/nodeIdentity.ts`

- [ ] Permission request + a `hasPermission` guard
- [ ] `getCurrentCoords()` at `Accuracy.BestForNavigation`, 8 s timeout, last-known fallback
- [ ] `watchCoords(cb)` for the responder view
- [ ] `nodeIdentity` — persisted random u8 (1–254) + a display callsign like `ALPHA-7`

**DoD:** coordinates captured on-device **in airplane mode**.

#### T3.4 — State store
**File:** `src/state/store.ts`

- [ ] zustand store: `incidents, clusters, peers, resources, dispatches, role, packetLog, meshStatus`
- [ ] Actions: `reportIncident, setStatus, dispatch, setRole, setTransportMode`
- [ ] Recomputes clusters on incident change (debounced 300 ms — do not cluster on every packet)
- [ ] Wires `MeshEngine.onChange` → store → UI

**DoD:** an action on node A visibly changes node C's state through MockTransport.

---

### Phase 4 — UI (1:40–2:40) · NativeWind throughout

#### T4.1 — Shell & primitives
**Files:** `App.tsx`, `src/components/RoleSwitcherBar.tsx`, `src/components/ui/{Button,Card,Pill,Screen}.tsx`

- [ ] `import './global.css'` as the very first line of `App.tsx`
- [ ] `SafeAreaProvider` + `GestureHandlerRootView` wrappers
- [ ] Tab shell: **Report · Incidents · Map · Resources · Mesh**
- [ ] Role switcher: Survivor / Responder / HQ — hides irrelevant tabs per role
- [ ] Shared primitives so no screen writes raw `View` styling

**DoD:** app boots on device, tabs switch, Tailwind classes visibly apply.

#### T4.2 — Report screen (Survivor)
**Files:** `src/screens/ReportScreen.tsx`, `src/components/{CategoryGrid,TriagePicker,CasualtyStepper,PresetChips}.tsx`

- [ ] **Three taps to submit.** Category grid (large icon tiles, `h-24`) → triage colour picker → send
- [ ] GPS status banner: acquiring / locked with accuracy in metres / failed
- [ ] Casualty stepper with a `many` option
- [ ] Preset chips filtered by chosen category
- [ ] Big red `SEND` button, `h-16`, with haptic feedback

**DoD:** a report submitted here appears in the local list and in the outbound rotation.

#### T4.3 — Incident list
**Files:** `src/screens/IncidentListScreen.tsx`, `src/components/{IncidentCard,StatusPill}.tsx`

- [ ] Sorted by `priorityScore` descending
- [ ] Card shows triage stripe, category icon, casualties, distance from me, `hops`, age, status pill
- [ ] `reportCount > 1` renders a `×N confirmations` badge
- [ ] Filter row: All / Unresolved / Mine
- [ ] Tap → detail sheet with status transition buttons (Responder/HQ only)

**DoD:** status changed here propagates through the mesh.

#### T4.4 — Command map ⭐
**Files:** `src/screens/CommandMapScreen.tsx`, `src/components/map/{TacticalMap,IncidentPin,ClusterRing,DispatchLine}.tsx`

- [ ] Equirectangular lat/lon → viewport projection, auto-fit to the incident bounds with padding
- [ ] Static PNG underlay with known corner coordinates (`src/assets/map/`)
- [ ] Pinch-zoom + pan via `react-native-gesture-handler`
- [ ] Triage-coloured pins, GPS accuracy circles, cluster rings scaled by `reportCount`
- [ ] Dashed dispatch lines from resource to target
- [ ] "My position" marker
- [ ] **Not** `react-native-maps` — see PLAN.md §5

**DoD:** pins land in correct relative positions; the cluster-collapse animation reads clearly.

#### T4.5 — Resources & dispatch
**Files:** `src/screens/ResourceScreen.tsx`, `src/components/{ResourceCard,MatchSuggestion}.tsx`

- [ ] Resource inventory list with distance and availability
- [ ] `AUTO-MATCH` button → ranked suggestions with the score breakdown shown
- [ ] One-tap Dispatch → emits the dispatch packet, sets status `IN_PROGRESS`

**DoD:** dispatch from HQ reaches the originating node through the mesh.

#### T4.6 — Mesh visualizer
**Files:** `src/screens/MeshScreen.tsx`, `src/components/{MeshGraph,PacketTicker,RadioStatus}.tsx`

- [ ] Peer graph: nodes sized by RSSI, edges appearing on packet exchange
- [ ] Live packet ticker — `RX 0x3F2A1B0C ttl 7→6 hops 1 · MEDICAL/RED`, monospace, autoscroll
- [ ] Radio status panel: BT on/off, advertising supported, location services on, permissions granted, transport mode
- [ ] Transport toggle: **BLE / Mock** — the hard-gate escape hatch from PLAN.md §8

**DoD:** the ticker shows real traffic; the transport toggle switches live without a restart.

---

### Phase 5 — BLE Transport (2:40–3:40) · devices required

#### T5.1 — Preflight
**File:** `src/services/blePreflight.ts`

- [ ] Runtime request for `BLUETOOTH_SCAN` / `ADVERTISE` / `CONNECT` + `ACCESS_FINE_LOCATION`
- [ ] Check Bluetooth adapter is on
- [ ] Check Location Services is on (many OEMs need it even with `neverForLocation`)
- [ ] Check `isMultipleAdvertisementSupported()`
- [ ] Return a structured result the Mesh screen renders as a checklist

**DoD:** all four checks green on all three phones. **This is a hard gate — run it first thing in Phase 5.**

#### T5.2 — BleTransport
**File:** `src/transport/BleTransport.ts`

- [ ] Advertise: `react-native-ble-advertiser`, company id `0xFFFF`, 20-byte payload, `LOW_LATENCY` / `TX_POWER_HIGH`
- [ ] Rotation timer — swap the advertised payload every 700 ms (stop → set → start; the library will not hot-swap)
- [ ] Scan: `react-native-ble-plx.startDeviceScan`, `allowDuplicates: true` (**essential** — without it you hear each advertiser once and the mesh dies)
- [ ] Parse `device.manufacturerData` from base64 → strip the 2-byte company id → `decodePacket`
- [ ] Filter on company id; ignore everything else in the room
- [ ] Duty cycle: 5 s scan on / 3 s off
- [ ] Peer tracking from RSSI + `originNodeId`
- [ ] Full teardown on unmount — a leaked advertiser survives app reload and confuses the next test

**DoD:** two phones exchange one real packet. Log the raw hex on both ends.

#### T5.3 — Hardware validation
- [ ] Two-phone exchange
- [ ] **Three-phone multi-hop** — 1 and 3 out of range, 2 relays. Verify `hops: 2` on node 3.
- [ ] Bidirectional: HQ dispatch reaches node 1 without node 1 ever seeing node 3
- [ ] Partition test: kill node 2, confirm divergence; restore, confirm convergence
- [ ] Airplane-mode run of the full flow

**DoD:** PLAN.md §9 manual checklist fully ticked.

---

### Phase 6 — Polish & Ship (3:40–4:30)

- [ ] T6.1 — Seed `src/mock/disasterPreset.ts` (12 incidents, 6 resources) behind a dev-only button
- [ ] T6.2 — Empty states, loading states, permission-denied states
- [ ] T6.3 — Cluster-collapse animation (Reanimated `withSpring` on pin position)
- [ ] T6.4 — `README.md`: architecture diagram, protocol table, run instructions, demo run-sheet
- [ ] T6.5 — Screenshots from all three devices
- [ ] T6.6 — Release APK: `npx expo run:android --variant release`
- [ ] T6.7 — Rehearse the 90-second run-sheet twice, timed

---

## E. Dependency Graph & Critical Path

```
types ──> presets ──> packetId ──> codec ⭐ ──> crdt ──> meshEngine ⭐ ──> MockTransport ──> store ──> UI
                                      │                      │                                    │
                                      │                      └──> BleTransport ⭐ ────────────────┤
                                      │                                                           │
                                      └──> geo ──> deduplicator ──> triageEngine ──> matcher ─────┘
```

**Critical path:** `codec → meshEngine → MockTransport → store → UI shell`.
Everything else (dedup, matcher, map polish, visualizer) is parallelizable or cuttable.

**Three starred modules carry the risk.** If you are behind schedule, cut from the
outside in — map polish first, then the visualizer, then the matcher, then dedup.
Never cut from the critical path.

**Parallelization if two people are building:**
- Dev A: `proto/` → `core/` → `transport/` → BLE (the critical path)
- Dev B: design system → UI primitives → screens against mocked store data
- Merge at the store interface, which is why T3.4 is defined before the screens are written.

---

## F. Development Workflow

### F.1 Terminal layout (four panes, keep them open all day)

| Pane | Command | Purpose |
| --- | --- | --- |
| 1 | `npx expo start --dev-client` | Metro bundler |
| 2 | `npm run test:watch` | Core tests, instant feedback |
| 3 | `npx tsc --noEmit --watch` | Type errors before they reach the device |
| 4 | free | git, adb, rebuilds |

### F.2 What needs a rebuild vs a reload

This is the single most common time-waster. Know it cold.

| Change | Action |
| --- | --- |
| Any `.ts` / `.tsx` in `src/` | Fast Refresh — automatic |
| `tailwind.config.js` | Restart Metro (`r` will not pick it up) |
| `global.css` | Restart Metro |
| `app.config.ts`, permissions, native modules | **Full rebuild:** `npx expo prebuild --clean && npx expo run:android` |
| New `expo install` package with native code | Full rebuild |
| `babel.config.js` / `metro.config.js` | `npx expo start --clear` |

### F.3 Three-device workflow

```bash
adb devices
```

Install to a specific device once built:

```bash
adb -s <SERIAL> install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- Label the phones physically: **A (Survivor) · B (Relay) · C (HQ)**. You will confuse them otherwise.
- Each device auto-generates its own `nodeId`; verify all three differ on the Mesh screen before testing.
- For range separation, B stays central; walk A and C apart until the Mesh graph shows them unlinked.
- Keep all three plugged in — BLE advertising plus GPS plus a bright screen drains fast.

### F.4 Debugging BLE (the things that will actually go wrong)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Scan returns nothing | Location Services off | Toggle it on (preflight catches this) |
| Each peer heard exactly once, then silence | `allowDuplicates: false` | Set it to `true` |
| Advertising throws | Missing runtime `BLUETOOTH_ADVERTISE` | Request at runtime, not just in the manifest |
| Payload truncated | Adv packet over 31 bytes | Drop the device name from the advertisement |
| Packets stop after a reload | Leaked advertiser from the previous session | Teardown on unmount; toggle Bluetooth off/on to clear |
| Works at 1 m, dead at 5 m | `TX_POWER` too low | `TX_POWER_HIGH`, `ADVERTISE_MODE_LOW_LATENCY` |

Log every send and receive as raw hex on both ends. When something is wrong, you need
to know whether the bytes left the radio or the decode failed — those are very
different bugs and they look identical from the UI.

### F.5 Git checkpoints

Commit at each of these, with these messages:

```
chore: scaffold + nativewind
feat(proto): 20-byte codec + tests green
feat(core): mesh engine + crdt + tests green
feat(transport): mock transport, 3-node sim working
feat(ui): shell + report + list
feat(ui): tactical map + mesh visualizer
feat(ble): real transport, 2-device exchange
feat(ble): 3-device multi-hop verified
docs: readme + demo sheet
```

If a phase breaks badly, `git stash` and fall back rather than debugging forward.

---

## G. Definition of Done

The build ships when all of these are true:

- [ ] `npm test` — all five suites green
- [ ] `npx tsc --noEmit` — clean
- [ ] App installs and boots on all three physical devices
- [ ] All four preflight checks green on all three devices
- [ ] Three-device multi-hop relay verified with `hops: 2` on the far node
- [ ] Bidirectional dispatch confirmed — HQ status change reaches the originator
- [ ] Full flow works with all three phones in **airplane mode**
- [ ] Deduplication visibly collapses multiple reports into one cluster
- [ ] Auto-match produces a sane dispatch recommendation
- [ ] Transport toggle switches BLE ↔ Mock live
- [ ] `README.md` complete
- [ ] Demo rehearsed twice, under 90 seconds

**Minimum shippable subset if time collapses:** codec + meshEngine + MockTransport +
Report screen + Incident list + Mesh visualizer. That still demonstrates the protocol,
the multi-hop relay, and the bidirectional sync — which is the entire pitch. The map,
matcher, and dedup are amplifiers, not the argument.
