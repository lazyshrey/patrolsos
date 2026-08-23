# Field testing

The app has four tabs: **Request**, **Incidents**, **Network**, **Checks**.
Everything below refers to those.

---

## 0. Install

```bash
adb install -r patrol-latest.apk
```

Signed with the standard debug keystore, so it installs on any phone with
"install from unknown sources" allowed. It is a **release** build — the
JavaScript is bundled in, so phones run standalone with no dev server and no
tether to your laptop. That matters when you walk them apart.

**Label the phones physically: A, B, C.** You will mix them up otherwise.

---

## 1. Preflight — four green lights

Open **Checks**. All four must be green on every phone before anything else.

| Check | If red |
| --- | --- |
| Bluetooth on | Turn Bluetooth on |
| Can advertise | **Hard stop.** This chipset cannot broadcast over BLE. Nothing in software fixes it — use a different phone. |
| Permissions | Tap **Start mesh** and accept the prompts |
| Location services | Pull down the shade and turn Location **on** |

The last two fail **silently** at the Android level. Location services is the
single most common cause of "nothing is working": Android hides Bluetooth scan
results when Location is off, even with permission granted.

Note the node number under the title. Each phone keeps its own across restarts
now, and all three must differ.

---

## 2. One phone — does it run at all

1. **Checks → Start mesh.** Accept the permission prompts.
2. **Request** should show "Location found, accurate to N m" within a few
   seconds outdoors. Indoors it may say no location — that is fine, reports
   still send.
3. Send a report: pick a category, an urgency, tap **Send**.
4. **Incidents** should list it immediately.
5. **Network → Your reports** should show *"Waiting to be picked up"* — correct
   with nobody else around.

Then force-close the app and reopen it. Your node number should be **the same**,
and your report should still be in Incidents. That is persistence working.

---

## 3. Two phones — the first real test

This is the one thing that cannot be proven in a simulator.

1. Start the mesh on **A** and **B**, side by side.
2. Send a report from **A**.
3. Within a few seconds **B** should show it under Incidents.
4. **B → Network** should list A as a nearby phone, marked **Direct**.
5. **A → Network → Your reports** should flip to **"Picked up by the mesh"**.

That last step is the delivery receipt: A heard B re-broadcasting A's own
packet. It proves the relay is real, not that B merely displayed something.

If nothing arrives, see Troubleshooting. Do not move on until this works.

---

## 4. Three phones — multi-hop relay

The whole thesis.

1. Start the mesh on all three. Put **B in the middle**.
2. Walk **A** and **C** apart until they cannot hear each other — typically
   30–50 m with a wall or two.
3. **Prove they are out of range:** stop the mesh on B, send from A, confirm
   **C receives nothing**. Restart B.
4. Send from **A**.
5. **C should receive it.** Open the incident on C — it should show **2 hops**.

`2 hops` is the proof. C never heard A directly; B carried it.

---

## 5. Status travels backward

1. Keep the Test 4 layout.
2. On **C**, tap the incident, then **Acknowledge**, then **Send a team**.
3. **A should show "On the way" within ~15 seconds** — with A and C never in
   direct range of each other.

This is the differentiator. A person gets confirmation that help is coming, over
a network with no infrastructure at all.

---

## 6. Partition and heal

1. Force-stop the app on **B**.
2. Send a new report from **A**. C should not receive it.
3. Restart the mesh on **B**.
4. C should pick it up as B re-broadcasts what it is carrying.

B is not a wire — it holds packets and keeps offering them.

---

## 7. Peer positions

1. All three running, outdoors so GPS locks.
2. Wait ~20 seconds.
3. **Network → Nearby** should list the other phones with a distance, and say
   **Direct** or **Through another phone**.
4. Walk one away — the distance should update within ~15 s.
5. Turn one off — it should disappear within ~30 s.

`position unknown` means that phone has no GPS fix yet. It is still relaying
fine; it just has nothing to share. Common indoors.

---

## 8. Locating a phone with no GPS

Needs three phones with a fix plus one without.

1. On the fourth phone, turn **Location off** but leave Bluetooth on, and start
   the mesh.
2. Keep the other three spread out — **not in a straight line**, or the geometry
   cannot pin a point.
3. Wait ~60 s for observations to circulate.
4. **Network → Estimated positions** should show it with a radius.

Expect tens of metres, not metres. The claim is narrowing a search from a
district to a building, nothing more.

---

## 9. Ringing a phone you cannot see

Two phones. This is the test the whole buzz feature exists for, so do it badly
on purpose: put the target somewhere you genuinely cannot see it.

1. On Phone B, turn the ringer to **silent**, lock the screen, and put it in a
   bag, a drawer, or under cushions. Leave the mesh running.
2. On Phone A, open **Network** and press **Ring** beside Phone B, then confirm.
3. Within a few seconds Phone B should alarm at **full volume through silent
   mode**, vibrate, and light up with a red full-screen alert.
4. Phone A should show Phone B under **"1 phone is ringing now"**, with a
   distance that refreshes every few seconds.
5. Let it run out. The alarm stops by itself after 30 seconds, Phone B's alert
   clears, and Phone B disappears from the ringing panel.
6. Press **Ring** again immediately. Nothing should happen — one caller is rate
   limited to one ring per phone per 20 seconds. Wait it out and try again.
7. Press **Silence** on Phone B mid-alarm. It must stay silent; a relayed copy
   of the same press arriving a second later must not restart it.

With three phones, put B out of A's range and buzz through the relay: the alert
on C should say the call came **through 1 phone**, and the answer should still
find its way back to A.

**Ring every phone nearby** does the same to everything in range at once. Do not
test that one in a public place.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Vibrates but silent | No alarm tone set on the device | Set any alarm sound in Clock |
| Nothing at all on the target | Mesh not running there | Start it in Checks |
| Alert appears late | Target was mid scan-off leg | Normal; listening is 5 s in every 9 |
| Second press ignored | 20 s caller cooldown | By design |

---

## 10. Surviving the background

This is the difference between a demo and a tool.

1. Start the mesh on Phone B. A permanent **PATROL is on** notification should
   appear, showing the live peer count.
2. Open **Checks → Running in the background**. Three lights: service running,
   notification allowed, battery unrestricted. If the last is red, tap **Allow
   PATROL to run unrestricted** and accept.
3. Press **Home** on Phone B — do *not* swipe the app away, and do not force
   stop it.
4. Lock Phone B and leave it for **ten minutes**.
5. From Phone A, send a report. Phone B should still relay it: check Phone C
   receives it at 2 hops, or ring Phone B and confirm it still answers.
6. Press **Stop** on Phone B's notification. The notification should vanish and
   the app, when reopened, should show the mesh as off.

Without the battery exemption, expect Phone B to go quiet somewhere between 15
minutes and an hour depending on the OEM. That is Doze, not a bug in the mesh,
and it is exactly what step 2 prevents.

---

## 11. No infrastructure at all

Put every phone in **airplane mode**, then turn Bluetooth back on. Repeat
Test 4, then Test 9. Behaviour should be identical. No cell, no Wi-Fi, no
internet.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Nothing received, `heard` stays 0 | Location services off | Turn Location on |
| "Can advertise" red | Chipset lacks peripheral mode | Different phone; no software fix |
| Nothing after a reload | Leaked advertiser from the last session | Toggle Bluetooth off and on |
| Works at 1 m, dead at 5 m | TX power | Already at maximum; check for obstructions |
| `dropped` climbing fast | Normal | Every duplicate counts as a drop; that is suppression working |
| Estimated position wildly off | Observers in a straight line | Spread them into a triangle |

**Counters** (Checks tab): `heard` = packets decoded off the radio including
duplicates · `relayed` = packets carried for someone else · `sent` = reports you
originated · `dropped` = duplicates suppressed plus undecodable advertisements.

On a healthy mesh `dropped` climbs much faster than `heard`. Each phone
re-advertises roughly once a second, so you hear the same packet many times and
ignore all but the first.

**Battery.** Listening runs 5 seconds in every 9. Advertising is continuous, so
you stay discoverable at all times. Expect meaningfully longer life than
flat-out scanning, but this is still a radio running constantly — keep phones
charged for long tests. Running in the background also holds a
partial wake lock, so the CPU never sleeps while the mesh is on: that is the
cost of not silently dropping out of the network, and it is charged whether the
screen is on or off.

---

## Known limits

- Packets are unsigned; anyone in range could inject a false report - or ring
  your phone. Buzz is rate limited per caller and self-expiring, which bounds
  the nuisance, but it does not authenticate anybody. Signed packets are a v2
  problem and they do not fit in 20 bytes.
- The buzz alarm forces the alarm stream to maximum for its duration and puts
  the previous volume back afterwards. A crash mid-alarm would leave it loud.
- Wi-Fi Direct is written but disabled — OEM group-formation behaviour is
  unverified.
- No map yet. The data exists; the rendering does not.
- Position estimates are areas, never pins.
