/**
 * Wi-Fi Direct bulk sync coordinator.
 *
 * This is NOT a replacement for BLE. BLE advertisement gossip is the floor that
 * always works — low power, no connection, every device supports it. Wi-Fi
 * Direct is the opportunistic upgrade: when two nodes are close, they swap
 * their entire stores in one socket exchange instead of dribbling 20 bytes per
 * advertising slot.
 *
 * ROLE SELECTION
 * --------------
 * Somebody has to be the group owner. There is no reliable way to know who else
 * is around before forming a group, so: try to JOIN first, and if nothing
 * answers within a timeout, CREATE the group and wait for others. Both sides
 * derive identical credentials, so whoever creates first wins and the other
 * naturally becomes a client.
 *
 * Everything runs on a cycle rather than continuously — Wi-Fi Direct is
 * expensive, and BLE is already carrying the urgent traffic.
 */

import PatrolWifi, {
  type GroupInfo,
  type WifiStatus,
} from '../../modules/patrol-wifi/src/PatrolWifiModule';
import { fromBase64, toBase64 } from '../services/base64';
import { deriveWifiCreds } from '../services/wifiCreds';
import type { MeshEngine } from '../core/meshEngine';

/** How long to wait for a group to form before giving up on this attempt. */
const JOIN_TIMEOUT_MS = 20_000;

/** Gap between sync attempts. Wi-Fi Direct is power-hungry; BLE covers the gap. */
export const SYNC_INTERVAL_MS = 120_000;

export type WifiSyncState =
  | 'idle'
  | 'joining'
  | 'hosting'
  | 'connected'
  | 'syncing'
  | 'unsupported'
  | 'error';

export interface WifiSyncStatus {
  state: WifiSyncState;
  isOwner: boolean;
  clientCount: number;
  lastSyncAt: number | null;
  lastReceived: number;
  networkName: string;
  message: string | null;
}

export class WifiSync {
  private engine: MeshEngine;
  private subs: Array<{ remove: () => void }> = [];
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private onChange?: () => void;

  private state: WifiSyncState = 'idle';
  private isOwner = false;
  private clientCount = 0;
  private lastSyncAt: number | null = null;
  private lastReceived = 0;
  private message: string | null = null;

  constructor(engine: MeshEngine, onChange?: () => void) {
    this.engine = engine;
    this.onChange = onChange;
  }

  static getStatus(): WifiStatus {
    return PatrolWifi.getStatus();
  }

  getStatus(): WifiSyncStatus {
    return {
      state: this.state,
      isOwner: this.isOwner,
      clientCount: this.clientCount,
      lastSyncAt: this.lastSyncAt,
      lastReceived: this.lastReceived,
      networkName: deriveWifiCreds().networkName,
      message: this.message,
    };
  }

  async start(): Promise<void> {
    const status = PatrolWifi.getStatus();
    if (!status.supported || !status.canFormGroupSilently) {
      this.state = 'unsupported';
      this.message = !status.supported
        ? 'This device has no Wi-Fi Direct'
        : 'Needs Android 10 or newer for dialog-free groups';
      this.emit();
      return;
    }

    await PatrolWifi.initialize();

    this.subs.push(
      PatrolWifi.addListener('onGroupInfo', (info) => this.handleGroupInfo(info))
    );
    this.subs.push(
      PatrolWifi.addListener('onPeerData', ({ data, count }) => {
        const accepted = this.engine.importBulk(fromBase64(data));
        this.lastReceived = count;
        this.lastSyncAt = Date.now();
        this.state = 'connected';
        this.message = `Received ${count} packets, ${accepted} new`;
        this.emit();
      })
    );
    this.subs.push(
      PatrolWifi.addListener('onError', ({ message }) => {
        this.message = message;
        this.emit();
      })
    );

    void this.cycle();
    this.cycleTimer = setInterval(() => void this.cycle(), SYNC_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.cycleTimer) clearInterval(this.cycleTimer);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.cycleTimer = null;
    this.joinTimer = null;
    for (const s of this.subs) s.remove();
    this.subs = [];
    await PatrolWifi.stopServer().catch(() => {});
    await PatrolWifi.removeGroup().catch(() => {});
    this.state = 'idle';
    this.emit();
  }

  /** One attempt: publish our store, try to join, fall back to hosting. */
  private async cycle(): Promise<void> {
    if (this.state === 'unsupported') return;

    this.publishStore();

    const { networkName, passphrase } = deriveWifiCreds();

    try {
      this.state = 'joining';
      this.message = 'Looking for a group…';
      this.emit();

      await PatrolWifi.joinGroup(networkName, passphrase);

      // Nothing answered — become the owner instead and let others come to us.
      this.joinTimer = setTimeout(() => {
        if (this.state === 'joining') void this.host(networkName, passphrase);
      }, JOIN_TIMEOUT_MS);
    } catch {
      await this.host(networkName, passphrase);
    }
  }

  private async host(networkName: string, passphrase: string): Promise<void> {
    try {
      this.state = 'hosting';
      this.message = 'Hosting a group';
      this.emit();
      await PatrolWifi.createGroup(networkName, passphrase);
      await PatrolWifi.startServer();
    } catch (e) {
      this.state = 'error';
      this.message = e instanceof Error ? e.message : String(e);
      this.emit();
    }
  }

  private handleGroupInfo(info: GroupInfo): void {
    this.isOwner = info.isOwner;
    this.clientCount = info.clientCount;

    if (!info.connected) {
      if (this.state !== 'joining' && this.state !== 'hosting') this.state = 'idle';
      this.emit();
      return;
    }

    this.publishStore();

    if (info.isOwner) {
      this.state = 'hosting';
      void PatrolWifi.startServer().catch(() => {});
    } else if (info.ownerAddress) {
      this.state = 'syncing';
      void PatrolWifi.syncWith(info.ownerAddress).catch(() => {});
    }
    this.emit();
  }

  /** Hand the native side the blob it should give any peer that connects. */
  private publishStore(): void {
    PatrolWifi.setOutgoing(toBase64(this.engine.exportAll()));
  }

  private emit(): void {
    this.onChange?.();
  }
}
