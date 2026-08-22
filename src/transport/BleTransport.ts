/**
 * Real radio transport: connectionless BLE advertisement gossip.
 *
 * Android can advertise exactly one payload at a time, so we cycle through the
 * engine's rotation on a timer. Scanning is duty-cycled (see below) with
 * CALLBACK_TYPE_ALL_MATCHES so we keep hearing repeats from the same peer.
 */

import { PermissionsAndroid, Platform } from 'react-native';
import PatrolBle, { type BleStatus } from '../../modules/patrol-ble/src/PatrolBleModule';
import type { PeerState, Transport } from '../types';
import { fromBase64, toBase64 } from '../services/base64';

/**
 * How fast we swap the advertised packet. Android rate-limits advertising
 * restarts, so going much below ~700 ms starts dropping payloads silently.
 */
export const ROTATE_MS = 900;

/**
 * Scan duty cycle.
 *
 * Continuous LOW_LATENCY scanning is a continuous radio receive and is by far
 * the biggest drain here — flat out, a phone dies in a few hours, which is
 * useless for a tool whose whole premise is the first 72 hours.
 *
 * ONLY SCANNING IS CYCLED. Advertising stays continuous, deliberately: a node
 * that stops advertising becomes invisible to everyone, whereas a node that
 * stops listening for a few seconds just misses packets it will hear again on
 * the next cycle — epidemic gossip re-delivers by design. Asymmetric, and the
 * asymmetry is the point.
 *
 * The off period is 4s rather than 3s because Android silently refuses more
 * than 5 scan starts per 30 seconds. A 9s cycle is 3.3 starts per 30s, which
 * leaves headroom; an 8s cycle sits at 3.75 and a shorter one would trip it and
 * fail with no error at all.
 */
export const SCAN_ON_MS = 5000;
export const SCAN_OFF_MS = 4000;

export class BleTransport implements Transport {
  private rotation: Uint8Array[] = [];
  private index = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private receiveCb: ((bytes: Uint8Array, rssi: number) => void) | null = null;
  private peerCb: ((peer: PeerState) => void) | null = null;
  private subs: Array<{ remove: () => void }> = [];
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;
  private alive = false;

  lastError: string | null = null;
  /** Exposed so Diagnostics can show what the radio is actually doing. */
  dutyState: 'listening' | 'idle' | 'off' = 'off';

  static getStatus(): BleStatus {
    return PatrolBle.getStatus();
  }

  static async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;

    const api = Number(Platform.Version);
    const wanted: string[] =
      api >= 31
        ? [
            'android.permission.BLUETOOTH_SCAN',
            'android.permission.BLUETOOTH_ADVERTISE',
            'android.permission.BLUETOOTH_CONNECT',
            'android.permission.ACCESS_FINE_LOCATION',
          ]
        : ['android.permission.ACCESS_FINE_LOCATION'];

    // NOTE: Wi-Fi Direct would also need NEARBY_WIFI_DEVICES from Android 13.
    // Deliberately NOT requested — the Wi-Fi path is parked (see WifiSync.ts),
    // and asking for a permission we do not use is both rude and confusing.

    const result = await PermissionsAndroid.requestMultiple(wanted as never[]);
    return Object.values(result).every((v) => v === 'granted');
  }

  async start(_nodeId: number): Promise<void> {
    this.subs.push(
      PatrolBle.addListener('onPacket', ({ data, rssi }) => {
        try {
          this.receiveCb?.(fromBase64(data), rssi);
        } catch {
          // A malformed advertisement must never take the node down.
        }
      })
    );

    this.subs.push(
      PatrolBle.addListener('onError', ({ where, code }) => {
        this.lastError = `${where} failed (code ${code})`;
      })
    );

    this.alive = true;
    await this.scanOn();

    this.timer = setInterval(() => {
      void this.tick();
    }, ROTATE_MS);
  }

  /**
   * One leg of the duty cycle. Each leg schedules the next, so a failed
   * start/stop cannot leave the radio stuck in one state.
   */
  private async scanOn(): Promise<void> {
    if (!this.alive) return;
    try {
      await PatrolBle.startScanning();
      this.scanning = true;
      this.dutyState = 'listening';
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
    this.scanTimer = setTimeout(() => void this.scanOff(), SCAN_ON_MS);
  }

  private async scanOff(): Promise<void> {
    if (!this.alive) return;
    try {
      await PatrolBle.stopScanning();
      this.scanning = false;
      this.dutyState = 'idle';
    } catch {
      // Already stopped; the next leg will bring it back.
    }
    this.scanTimer = setTimeout(() => void this.scanOn(), SCAN_OFF_MS);
  }

  async stop(): Promise<void> {
    this.alive = false;
    this.dutyState = 'off';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    for (const s of this.subs) s.remove();
    this.subs = [];
    try {
      await PatrolBle.stopScanning();
      await PatrolBle.stopAdvertising();
    } catch {
      // Already down.
    }
  }

  setBroadcastSet(packets: Uint8Array[]): void {
    this.rotation = packets;
    if (this.index >= packets.length) this.index = 0;
  }

  onReceive(cb: (bytes: Uint8Array, rssi: number) => void): void {
    this.receiveCb = cb;
  }

  onPeer(cb: (peer: PeerState) => void): void {
    this.peerCb = cb;
  }

  private async tick(): Promise<void> {
    if (this.rotation.length === 0) return;
    const packet = this.rotation[this.index % this.rotation.length];
    this.index = (this.index + 1) % this.rotation.length;
    try {
      await PatrolBle.setPayload(toBase64(packet));
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }
}
