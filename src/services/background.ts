/**
 * Keeping the node alive when nobody is looking at it.
 *
 * A mesh made of phones only works if the phones stay in it. Android disagrees:
 * a backgrounded app is frozen within minutes, its BLE scans throttled to
 * nothing and its timers suspended, and the user is never told. The phone looks
 * like a running node and is in fact a brick with a green dot.
 *
 * The fix is a foreground service and its permanent notification, which is a
 * real cost and worth paying explicitly. This module is the thin JS side of
 * that, and it degrades quietly: without the native module every call is a
 * no-op and the app still runs, just only while it is on screen.
 */

import { PermissionsAndroid, Platform } from 'react-native';
import PatrolService, {
  type ServiceStatus,
} from '../../modules/patrol-service/src/PatrolServiceModule';

const OFF: ServiceStatus = {
  running: false,
  notificationsAllowed: false,
  batteryUnrestricted: false,
};

export const backgroundAvailable = PatrolService != null;

export function backgroundStatus(): ServiceStatus {
  try {
    return PatrolService?.getStatus() ?? OFF;
  } catch {
    return OFF;
  }
}

/**
 * Android 13 needs POST_NOTIFICATIONS before a foreground service notification
 * can be shown. Denying it does not stop the service, only its notification —
 * and a foreground service the user cannot see is exactly the kind of thing
 * this app should not do, so we ask.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (Number(Platform.Version) < 33) return true;
  try {
    const result = await PermissionsAndroid.request(
      'android.permission.POST_NOTIFICATIONS' as never
    );
    return result === 'granted';
  } catch {
    return false;
  }
}

export async function startBackground(title: string, text: string): Promise<void> {
  try {
    await PatrolService?.start(title, text);
  } catch {
    // No service means no background survival, which is a degradation the
    // Diagnostics screen reports. It must never stop the radio starting.
  }
}

export async function updateBackground(title: string, text: string): Promise<void> {
  try {
    await PatrolService?.update(title, text);
  } catch {
    /* non-fatal */
  }
}

export async function stopBackground(): Promise<void> {
  try {
    await PatrolService?.stop();
  } catch {
    /* already down */
  }
}

/** Opens the Doze exemption prompt. Returns false if the OS refused to show it. */
export async function requestBatteryExemption(): Promise<boolean> {
  try {
    return (await PatrolService?.requestBatteryExemption()) ?? false;
  } catch {
    return false;
  }
}

/** Fires when the user presses Stop on the ongoing notification. */
export function onBackgroundStopRequested(cb: () => void): { remove: () => void } {
  const sub = PatrolService?.addListener('onStopRequested', cb);
  return { remove: () => sub?.remove() };
}

/**
 * The line under "PATROL" in the notification.
 *
 * Written to be readable on a lock screen at a glance, because that is the only
 * place most people will ever see it.
 */
export function notificationText(opts: {
  peers: number;
  incidents: number;
  outboxPending: number;
}): string {
  const parts: string[] = [];
  parts.push(
    opts.peers === 0
      ? 'Listening — no phones in range'
      : `${opts.peers} phone${opts.peers === 1 ? '' : 's'} nearby`
  );
  if (opts.incidents > 0) {
    parts.push(`${opts.incidents} report${opts.incidents === 1 ? '' : 's'} carried`);
  }
  if (opts.outboxPending > 0) {
    parts.push(`${opts.outboxPending} still sending`);
  }
  return parts.join(' · ');
}
