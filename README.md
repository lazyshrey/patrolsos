# P.A.T.R.O.L.

**Peer-to-peer Aid, Tracking, & Remote Offline Link**

Disaster coordination for the first 72 hours, when there is no cell network, no
Wi-Fi and no internet. Phones talk directly to each other over Bluetooth and
pass reports along until they reach help.

Android · MIT licensed · no servers, no accounts, no infrastructure.

---

## What it does

- **Report what you need** in three taps — category, urgency, how many people.
  Your GPS position rides along, captured from satellites, which work with no
  cellular data at all.
- **Reports hop phone to phone.** A report from someone out of range reaches you
  because a phone in between carried it. Seven hops by default.
- **Duplicate reports merge.** Six people reporting the same collapsed building
  become one incident with six confirmations, not six incidents.
- **Status travels back.** When base marks your report "on the way", that
  confirmation finds its way back to you across the same mesh. You learn help is
  coming without ever being in range of base.
- **People with no GPS can still be found.** If three phones hear a phone that
  has no satellite fix — trapped, in a basement, in a stairwell — its position
  is estimated from signal strength.
- **Nothing is lost on restart.** Reports and your identity persist.

---

## How it works

### Connectionless BLE advertisement gossip

Every phone continuously broadcasts a **20-byte packet** inside a Bluetooth LE
advertisement, and listens for the same. Hearing an unknown packet means: store
it, merge it, and re-broadcast it with one less hop remaining. Spread emerges
from nothing but advertise and scan.

There are **no connections**. That single decision removes MTU negotiation,
fragmentation and reassembly, pairing dialogs, connection lifecycle, and
Android's ~7 simultaneous GATT connection limit. A broadcast also reaches every
phone in range at once rather than one at a time.

The cost is that a packet must fit in 20 bytes, so descriptions are chosen from
a fixed list rather than typed. In an emergency that is faster anyway, and it
makes duplicate detection deterministic instead of fuzzy text matching.

### The packet

| Off | Size | Field |
| --- | --- | --- |
| 0 | 4 | `packetId` — SHA-256 of the identity tuple, content-addressed |
| 4 | 8 | `lat`, `lon` — fixed point, 1e6, sub-metre |
| 12 | 1 | `category` : `triage` (two nibbles) |
| 13 | 1 | `casualties` |
| 14 | 1 | `ttl` : `hops` |
| 15 | 2 | `lamport` — logical clock |
| 17 | 1 | `status` |
| 18 | 1 | `descPreset` |
| 19 | 1 | `originNodeId` |

Four packet types reuse the same frame rather than adding new formats:

- **Incident** — someone needs help
- **Presence** — "I am here", so peers can be placed on a map
- **Observation** — "I heard node Y at strength Z, from here", the raw material
  for locating a phone with no GPS
- **Dispatch** — a team assignment travelling back toward the reporter

### Conflict resolution

Status is a **monotonic lattice** — `Reported < Acknowledged < In progress <
Resolved` — and merging is `max()`. Conflict-free by construction, needs no
clock, and a resolved incident can never regress no matter what order packets
arrive in. Mutable fields use a Lamport last-writer-wins register, tiebroken on
node id so every phone picks the same winner.

### Delivery receipts without acknowledgements

Broadcasting is fire-and-forget, so *"did my report get out?"* has no obvious
answer. But when a peer relays your packet it re-broadcasts with the hop count
incremented — and you hear it. **A packet carrying your own node id with hops
above zero is proof someone picked it up.** A real receipt, free, no protocol
addition.

It proves relay, not rescue, and the app says exactly that.

---

## Build and run

Requires Node 20+, JDK 17, and the Android SDK.

```bash
npm install
```

```bash
npx expo prebuild --platform android --clean
```

```bash
cd android && ./gradlew assembleRelease
```

The APK lands at `android/app/build/outputs/apk/release/app-release.apk`. It is
a **release** build, so the JavaScript is bundled in and phones run standalone
with no dev server — which matters when you are walking them apart to test
range.

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Run the engine tests, which need no device:

```bash
npm test
```

---

## Testing it for real

See [TESTING.md](TESTING.md). The test that matters is three phones in a line
with the outer two out of range of each other: a report sent from one end must
arrive at the other showing **2 hops**.

Before anything else, check the four lights on the Checks tab. Two of them fail
silently at the Android level:

- **Can advertise** — some chipsets cannot broadcast at all. No software fix.
- **Location services** — Android hides Bluetooth scan results when Location is
  off, even with permission granted. This is the single most common cause of
  "nothing works".

---

## Project layout

```
src/
  proto/      20-byte codec, content addressing, preset phrases
  core/       gossip engine, CRDT merge, dedup, trilateration, outbox
  transport/  Transport interface + BLE, mock and Wi-Fi implementations
  services/   storage, GPS, SHA-256, identity
  ui/         screens and design tokens
modules/
  patrol-ble/   native Android BLE advertise + scan (Kotlin)
  patrol-wifi/  native Wi-Fi Direct bulk sync (parked, see below)
```

**Nothing in `src/proto` or `src/core` imports React Native.** That is what lets
the entire engine run under `npm test` in seconds with no device — including
multi-hop relay, backward status propagation and trilateration, all verified in
a simulated mesh before any hardware is involved.

---

## Deliberately not done

Stated plainly, because a limitation you name yourself is worth more than one a
reviewer finds.

- **Packets are unsigned.** Anyone in range could inject a false report. A
  64-byte signature does not fit in a 20-byte advertisement; fixing it properly
  needs a second channel and a v2 packet. Real trade: reach and simplicity now,
  authentication later.
- **Wi-Fi Direct is written but parked.** The dialog-free autonomous group path
  (Android 10+) works in principle and the code is unit-tested, but OEM
  behaviour around group formation varies too much to enable untested. Behind
  `ENABLE_WIFI_DIRECT`.
- **No offline map yet.** MapLibre plus a pre-downloaded region is the plan; the
  data it would render — incidents, peers, uncertainty circles — already exists.
- **iOS is not supported.** iOS heavily restricts BLE advertising in the
  background and has no Wi-Fi Direct at all.
- **Position estimates are areas, not pins.** Signal-strength ranging is tens of
  metres at best and worse indoors, which is exactly where it gets used. The app
  never draws a point it cannot justify.

---

## Credits

Protocol design informed by two prior projects, both read for approach rather
than code:

- [protestchat](https://github.com/ni5arga/protestchat) (MIT) — same Expo and
  React Native stack, same conclusion that a hand-written native module beats
  the available libraries. Its scanner tuning and its "infer peer loss from
  silence" approach are used here, with thanks.
- [bitchat](https://github.com/permissionlesstech/bitchat) — independent
  validation of TTL 7 and controlled-flood relay. No code taken; the Android
  implementation is GPL-3.0 and incompatible with this project's licence.

## Licence

MIT. See [LICENSE](LICENSE).
