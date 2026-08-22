/**
 * Real radio transport: connectionless BLE advertisement gossip.
 *
 * Android can advertise exactly one payload at a time, so we cycle through the
 * engine's rotation on a timer. Scanning runs continuously with
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

export class BleTransport implements Transport {
  private rotation: Uint8Array[] = [];
  private index = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private receiveCb: ((bytes: Uint8Array, rssi: number) => void) | null = null;
  private peerCb: ((peer: PeerState) => void) | null = null;
  private subs: Array<{ remove: () => void }> = [];

  lastError: string | null = null;

  static getStatus(): BleStatus {
    return PatrolBle.getStatus();
  }

  static async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;

    const wanted: string[] =
      Number(Platform.Version) >= 31
        ? [
            'android.permission.BLUETOOTH_SCAN',
            'android.permission.BLUETOOTH_ADVERTISE',
            'android.permission.BLUETOOTH_CONNECT',
            'android.permission.ACCESS_FINE_LOCATION',
          ]
        : ['android.permission.ACCESS_FINE_LOCATION'];

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

    await PatrolBle.startScanning();

    this.timer = setInterval(() => {
      void this.tick();
    }, ROTATE_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
