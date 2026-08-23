<div align="center">
  <br />
  <img src="assets/logo.png" alt="P.A.T.R.O.L. Logo" width="130" />
  <br />
  <h1>🚨 P.A.T.R.O.L.</h1>
  <p><strong>Peer-to-peer Aid, Tracking, & Remote Offline Link</strong></p>
  <p><i>Decentralized, zero-infrastructure disaster coordination mesh for Android over connectionless BLE gossip.</i></p>

  <br />

  <div>
    <a href="https://lazyshrey.com"><img src="https://img.shields.io/badge/🌐_Website-lazyshrey.com-000000?style=for-the-badge" alt="Website" /></a>
    <a href="https://discord.com/invite/ZVCB8EnRX2"><img src="https://img.shields.io/badge/Discord-Join_Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
    <img src="https://img.shields.io/badge/Platform-Android-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Android" />
    <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Radio-BLE_Gossip-0082FC?style=for-the-badge" alt="BLE Gossip" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-F59E0B?style=for-the-badge" alt="MIT" /></a>
  </div>

  <br />

  <p>
    <a href="#about">About</a> •
    <a href="#how-it-works">How It Works</a> •
    <a href="#wire-packet">Wire Packet</a> •
    <a href="#app-screens">Screens</a> •
    <a href="#quick-start">Quick Start</a> •
    <a href="#field-testing">Testing</a> •
    <a href="#deliberately-not-done">Limitations</a>
  </p>
</div>

---

## About

**P.A.T.R.O.L.** is an offline-first disaster coordination mesh for the first 72 hours of an emergency when cellular networks, power grids, and internet infrastructure fail.

Phones communicate directly with each other via **connectionless Bluetooth Low Energy (BLE) advertisements**—passing distress signals, triage statuses, and casualty counts hop-by-hop across devices without servers, internet, or accounts.

<br />

<div align="center">
  <table border="0" cellspacing="0" cellpadding="16">
    <tr>
      <td width="300" valign="top" style="border: 1px solid #333; border-radius: 12px; background: rgba(255,255,255,0.03);">
        <h3>📡 Connectionless BLE</h3>
        <p>No pairing popups or GATT connection limits. 20-byte raw frames broadcast to all nearby phones simultaneously.</p>
      </td>
      <td width="300" valign="top" style="border: 1px solid #333; border-radius: 12px; background: rgba(255,255,255,0.03);">
        <h3>🔄 7-Hop Relay Mesh</h3>
        <p>Controlled epidemic gossip automatically relays urgent reports across intermediate nodes to reach rescue teams.</p>
      </td>
    </tr>
    <tr>
      <td width="300" valign="top" style="border: 1px solid #333; border-radius: 12px; background: rgba(255,255,255,0.03);">
        <h3>📐 GPS-Free Localization</h3>
        <p>Estimates positions of victims trapped in basements or rubble without GPS using multi-peer RSSI observations.</p>
      </td>
      <td width="300" valign="top" style="border: 1px solid #333; border-radius: 12px; background: rgba(255,255,255,0.03);">
        <h3>🔁 Backward Status Flow</h3>
        <p>Dispatch updates ("Help on the way") travel backward across the mesh to notify the original reporter.</p>
      </td>
    </tr>
    <tr>
      <td width="300" valign="top" style="border: 1px solid #333; border-radius: 12px; background: rgba(255,255,255,0.03);">
        <h3>🔔 Buzz to Locate</h3>
        <p>Ring a phone you cannot see. It sounds a full-volume alarm through silent mode and answers with its position every few seconds.</p>
      </td>
      <td width="300" valign="top" style="border: 1px solid #333; border-radius: 12px; background: rgba(255,255,255,0.03);">
        <h3>🌙 Runs in the Background</h3>
        <p>A foreground service and wake lock keep the node relaying, and reachable by a buzz, with the screen off and the app closed.</p>
      </td>
    </tr>
  </table>
</div>

<br />

---

## How It Works

- **Connectionless (1-to-N)**: Continuous raw advertising and scanning. Reaches every phone in radio range at once, avoiding Android's ~7 GATT connection limit and all pairing prompts.
- **Monotonic CRDT Status**: Merging is `Math.max(local, remote)` across `Reported < Acknowledged < In Progress < Resolved`. A resolved incident can never regress.
- **Echo Delivery Receipts**: When a peer relays your packet, it re-broadcasts with `hops > 0`. Hearing your own packet ID with `hops > 0` confirms the mesh picked it up.
- **Spatial Deduplication**: Geohash6 + Haversine ($\le 150\text{ m}$) clustering collapses duplicate bystander reports into a single incident with confirmation counts.

---

## Buzz - Ringing a Phone You Cannot See

RSSI trilateration narrows a silent phone to a circle tens of metres across. That is enough to pick the right building and not enough to pick the right room, let alone the right void under a slab. **Buzz closes the last few metres with sound.**

Press **Ring** on a peer, or **Ring every phone nearby**, and the target phone:

1. **Sounds a full-volume alarm** on Android's `STREAM_ALARM`, so it plays through silent mode and Do Not Disturb, plus a distinct vibration waveform that carries through a slab when air does not.
2. **Answers with its position** every 5 seconds for the length of the alarm, taking a one-shot high-accuracy GPS fix at the moment it is rung.
3. **Gets triangulated by everyone else**: every phone that hears the buzz go past files fresh RSSI observations of the phone about to ring, so the search circle tightens at the same moment the noise starts.

The searcher sees a live *"N phones are ringing now"* panel with refreshing distances. The person being rung gets a full-screen alert explaining what is happening, with a single **Silence - I am safe and found** button.

**The design constraints that make it safe:**

- **Presses, not packets.** A buzz is named `originNodeId:lamport`. In steady state one press is heard dozens of times through relays; keying the alarm on the press means it rings **once**, and a silenced alarm stays silenced.
- **Rate limited.** One caller cannot re-ring the same phone inside 20 seconds, however hard they hammer the button.
- **Self-expiring.** A buzz carries its own duration (5-180 s, default 30) and leaves the broadcast rotation when the alarm ends, so nobody keeps announcing an emergency that is over.
- **Confirmed.** Ringing a stranger's phone at alarm volume is irreversible from the caller's side, so it takes one tap of confirmation.
- **Prioritised.** A buzz outranks every other packet in the rotation, in both directions. It is the only packet in the protocol with a deadline measured in seconds.

Two categories carry it, reusing the same 20-byte frame: `BUZZ (10)`, where `casualties` is the target node id (`255` = everyone) and `descPreset` is the ring duration; and `BUZZ_ACK (11)`, where `lat`/`lon` are the responder's own position and `descPreset` is their battery.

---

## Running in the Background

Android freezes a backgrounded app within minutes: BLE scanning is throttled to nothing and the JS timers driving the broadcast rotation simply stop. The phone looks like a running node and is in fact a brick with a green dot - which is the exact failure this app cannot have, because a phone in a pocket with the screen off *is* the normal case.

`modules/patrol-service` holds the two things that fix it:

- **A foreground service**, which keeps the process off the kill list. The price is a permanent notification, and that is the right price - a phone quietly running its radio flat should say so. It shows the live peer count, tapping it opens the app, and it carries a **Stop** button that shuts the radio down cleanly.
- **A `PARTIAL_WAKE_LOCK`**, which keeps the CPU running with the screen off. Without it Doze suspends the JS thread within minutes.

The service declares `foregroundServiceType="connectedDevice|location"` but only claims the `location` half when fine location has actually been granted - claiming a type without its permission is what makes Android 14 throw at `startForeground`. **Checks** reports service state, notification permission and Doze exemption, with a one-tap prompt for the last.

---

## Wire Packet (`PATROL/1`)

Every packet is a compact **20-byte binary frame** (big-endian) that fits inside a single standard BLE advertisement:

| Off | Size | Field | Description |
| :---: | :---: | :--- | :--- |
| `0` | 4 B | `packetId` | Content-addressed SHA-256 slice (coordinates, category, origin, 15m time bucket) |
| `4` | 8 B | `lat`, `lon` | Fixed-point coordinates ($10^{-6}$ deg, ~11 cm precision) |
| `12` | 1 B | `category : triage` | Packed nibbles: Category (0-14, incl. `10 BUZZ` / `11 BUZZ_ACK`) & S.T.A.R.T. triage (0-4) |
| `13` | 1 B | `casualties` | Casualty count ($255 =$ many) |
| `14` | 1 B | `ttl : hops` | Packed nibbles: TTL (starts at 7) & Hops (caps at 15) |
| `15` | 2 B | `lamport` | Logical clock for Last-Writer-Wins field updates |
| `17` | 1 B | `status` | Monotonic lattice (`0: Reported`, `1: Ack`, `2: In Progress`, `3: Resolved`) |
| `18` | 1 B | `descPreset` | Pre-defined phrase index for deterministic deduplication |
| `19` | 1 B | `originNodeId` | Issuing node ID & deterministic tiebreaker |

---

## App Screens

- **Request**: 3-tap panic reporting with S.T.A.R.T. triage and automatic satellite GPS tagging.
- **Incidents**: Real-time triage feed with merged clusters and reverse status dispatching.
- **Network**: The **offline map** — every peer, estimated position and report drawn at true bearing and distance with the radio links between them, pan/pinch/tap, no tiles and no network — over live mesh telemetry, peer hop distances, outbox delivery receipts, and the **Ring** controls for buzzing a peer or everyone in range.
- **Checks**: Preflight diagnostics for BLE advertising, scanning, permissions, location services and the background service.

---

## Quick Start

### 1. Install & Test
```bash
npm install
npm test
```
*(All 13 test suites and 119 unit tests run in pure TypeScript/Jest with zero device requirements).*

### 2. Build Release APK
```bash
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```
APK output: `android/app/build/outputs/apk/release/app-release.apk` (or install [`patrol-latest.apk`](patrol-latest.apk)).

### 3. Sideload to Device
```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

---

## Field Testing

See [TESTING.md](TESTING.md) for full physical mesh testing protocols:

1. **Preflight**: Open **Checks** tab — ensure all 4 status indicators are green.
2. **Multi-Hop Relay**: Place Phone B between Phone A and Phone C (with A and C out of direct range). Reports sent from A arrive at C showing **`2 hops`**.
3. **Status Flow Back**: Acknowledge on Phone C — Phone A updates to **"On the way"** across the relay.
4. **Offline Resilience**: Turn on Airplane mode on all devices (with Bluetooth on) — mesh runs 100% offline.
5. **Buzz**: Lock Phone C, put it in a bag, and press **Ring** on it from Phone A. It should alarm at full volume through silent mode and appear under *"phones are ringing now"* with a refreshing distance.
6. **Background Survival**: Close the app on Phone B (do not force-stop it) and confirm the ongoing notification stays up and Phone A still relays through it.

---

## Deliberately Not Done

- **Unsigned Packets in v1**: 64-byte cryptographic signatures cannot fit in a 20-byte legacy BLE frame. Prioritizes maximum reach and zero latency; signed payloads planned for v2.
- **Wi-Fi Direct Parked**: Native module is implemented in `modules/patrol-wifi` but parked due to aggressive OEM background variations.
- **Android Only**: iOS heavily restricts background BLE advertising.
- **Area Estimates**: RSSI localization calculates area confidence circles ($\sim 30\text{--}80\text{ m}$), not false pinpoint coordinates.

---

## License

[MIT](LICENSE)
