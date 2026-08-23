/**
 * The siren, from JS.
 *
 * Wraps the native alarm and falls back to react-native's Vibration when the
 * module is missing. The fallback is much weaker — no sound, and it stops when
 * the process does — but a phone buzzing in a pocket is still better than a
 * phone doing nothing, so it is worth having.
 */

import { Vibration } from 'react-native';
import PatrolAlert from '../../modules/patrol-alert/src/PatrolAlertModule';

export const alarmAvailable = PatrolAlert != null;

/** Matches the native waveform so the two feel like one feature. */
const FALLBACK_PATTERN = [0, 700, 300, 700, 900];

let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

export async function ring(seconds: number, who: string, detail: string): Promise<void> {
  if (PatrolAlert) {
    try {
      await PatrolAlert.ring(seconds, who, detail);
      return;
    } catch {
      // Fall through to the vibration-only path.
    }
  }

  Vibration.vibrate(FALLBACK_PATTERN, true);
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(() => {
    Vibration.cancel();
    fallbackTimer = null;
  }, seconds * 1000);
}

export async function silence(): Promise<void> {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  Vibration.cancel();
  try {
    await PatrolAlert?.stop();
  } catch {
    /* already silent */
  }
}

export function isRinging(): boolean {
  try {
    return PatrolAlert?.isRinging() ?? fallbackTimer != null;
  } catch {
    return false;
  }
}

/** Fires when the alarm reaches its deadline on its own. */
export function onRingEnd(cb: () => void): { remove: () => void } {
  const sub = PatrolAlert?.addListener('onRingEnd', cb);
  return { remove: () => sub?.remove() };
}
