# Field test — does the mesh actually work?

This build exists to answer one question on real hardware:

> Does a 20-byte packet relay from phone A to phone C **through** phone B,
> and does a status change travel back the other way?

Everything else — the designed UI, the map, dedup, resource matching — waits
until this is answered.

---

## 1. Install

```bash
adb devices
```

The APK is at `android/app/build/outputs/apk/release/app-release.apk`. It is
signed with the standard debug keystore, so it installs on any phone with
"install from unknown sources" allowed. It is a **release** build — the JS is
bundled in, so the phones do **not** need to stay near your laptop or have
Metro running.

Install to each phone:

```bash
adb -s <SERIAL> install -r android/app/build/outputs/apk/release/app-release.apk
```

Or copy the APK over and tap it on each device.

**Label the phones physically. A, B, C.** You will mix them up otherwise.

---

## 2. Preflight — all four lights green

Open the app. The "Radio check" panel must show four greens on every phone:

| Check | If red |
| --- | --- |
| Bluetooth on | Turn Bluetooth on |
| Can advertise | **Hard stop.** This chipset cannot do BLE peripheral advertising. Swap the phone. |
| Permissions | Tap Start mesh and accept "Nearby devices" + "Location" |
| Location services | Pull down the shade and turn Location ON — Android hides BLE scan results without it, even when permissions are granted |

The third and fourth fail **silently** at the Android level. That is why they
are surfaced here rather than left to be debugged later.

Note the node number shown under the title — each phone generates its own on
launch, and all three must differ.

---

## 3. Test 1 — two phones talk at all

1. Start mesh on **A** and **B**, sitting next to each other.
2. On A, tap **Send NOW**.
3. Within a few seconds B should show the incident, with `hops 1` and
   `from <A's node number>`.
4. B's "heard" counter should climb.

If nothing arrives, see Troubleshooting below. Do not move on until this works.

---

## 4. Test 2 — the real one: multi-hop relay

This is the whole thesis.

1. Start mesh on all three.
2. Put **B in the middle**. Walk **A** and **C** apart until they can no longer
   hear each other directly — typically 30–50 m with a wall or two, or opposite
   ends of a building.
3. Confirm they are genuinely out of range: stop the mesh on B, send from A,
   and check that **C receives nothing**. Restart B.
4. Send from **A**.
5. **C should receive the incident with `hops 2`.**

`hops 2` is the proof. It means the packet was relayed twice: once by B's radio
after B heard it from A. C never heard A directly.

---

## 5. Test 3 — status travels backward

1. With the Test 2 layout still standing, on **C** tap the incident.
2. It advances `Reported → Seen by base → On the way`.
3. **A should show the new status within ~10 seconds**, without A and C ever
   being in direct range.

This is the differentiator. A victim gets confirmation that help is coming,
over a network with no infrastructure at all.

---

## 6. Test 4 — partition and heal

1. Force-stop the app on **B**.
2. Send a new report from **A**. C should not receive it.
3. Restart the mesh on **B**.
4. C should pick the report up as B re-broadcasts what it is carrying.

This shows store-and-forward: B is not just a wire, it holds packets and keeps
offering them.

---

## 7. Test 5 — no infrastructure at all

Put all three phones in **airplane mode**, then turn Bluetooth back on. Repeat
Test 2. Everything should behave identically. No cell, no Wi-Fi, no internet.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing received, "heard" stays 0 | Location services off | Turn Location on — the single most common cause |
| Each peer heard once then silence | Scan duplicate filtering | Already handled: `CALLBACK_TYPE_ALL_MATCHES` + `reportDelay 0` |
| "Can advertise" red | Chipset lacks peripheral mode | Use a different phone; nothing in software fixes this |
| Advertising throws | `BLUETOOTH_ADVERTISE` not granted at runtime | Restart the mesh and accept the prompt |
| Works at 1 m, dead at 5 m | TX power | Already at `ADVERTISE_TX_POWER_HIGH` / `ADVERTISE_MODE_LOW_LATENCY` |
| Stops after reload | Leaked advertiser from the previous session | Toggle Bluetooth off/on |
| dropped counter climbing fast | Normal | Every duplicate you hear counts as a drop; that is suppression working |

---

## What the counters mean

- **heard** — packets decoded off the radio, including duplicates you suppress
- **relayed** — packets you re-broadcast on someone else's behalf
- **sent** — reports you originated
- **dropped** — duplicates suppressed, plus undecodable advertisements

On a healthy 3-phone mesh, `dropped` climbing much faster than `heard` is
expected and correct — each phone re-advertises every ~900 ms, so you hear the
same packet many times and ignore all but the first.

---

## Known limits of this build

- Node id is regenerated on every launch (persisting it needs a storage
  dependency and another rebuild). Written down on screen so you can track it.
- No deduplication, no map, no resource matching yet — engine only.
- The UI is a test harness, not the designed app.
- Packets are unsigned. Anyone could inject a false report. Documented
  trade-off: a 64-byte signature does not fit in a 20-byte advertisement.
