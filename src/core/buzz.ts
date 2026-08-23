/**
 * Buzz — ringing a phone you cannot see.
 *
 * The localization module can narrow a silent phone down to a circle tens of
 * metres across. That is enough to search a building, and not enough to find
 * someone under a slab of it. The last few metres are solved with your ears,
 * not with arithmetic: make the phone scream, and walk towards the sound.
 *
 * So a buzz does two things at once, and both matter:
 *
 *   1. The target phone starts a full-volume alarm on the ALARM stream, so it
 *      sounds through silent mode, through a pocket, through debris.
 *   2. The target phone immediately answers with where it is, and every phone
 *      that hears it ringing files a fresh observation — so the circle tightens
 *      at the same moment the noise starts.
 *
 * WHY THE LAMPORT CLOCK IS THE PRESS ID
 * -------------------------------------
 * In steady state a node re-advertises its rotation about once a second, and
 * every neighbour relays it. One press of the button is therefore heard dozens
 * of times. Restarting the alarm on each copy would make it stutter and would
 * make "stop" impossible — the next duplicate would start it again.
 *
 * The caller's Lamport clock increments once per press and travels through
 * relays unchanged, so `originNodeId:lamport` names the PRESS rather than the
 * packet. Ring once per press, ignore every echo of it. This is the same
 * reasoning as the engine's seen-set, applied to an effect in the physical
 * world rather than to a rebroadcast.
 *
 * Pure module: no react-native, no expo. The actual siren lives in
 * src/services/alarm.ts.
 */

import type { Packet } from '../types';
import { Category } from '../types';

/** Target value meaning "every phone that can hear this". */
export const BUZZ_ALL = 0xff;

/**
 * Buzz travels further than presence (2) and further than an observation (4).
 *
 * A rescuer standing at the edge of a collapsed block wants to ring the phones
 * inside it, and those are exactly the phones only reachable through two or
 * three relays. It stays bounded because a buzz is loud: flooding a whole city
 * with alarms would be worse than useless.
 */
export const BUZZ_TTL = 5;

/** How long the alarm sounds, unless the caller asks for something else. */
export const DEFAULT_RING_SECONDS = 30;

/** Clamped on the wire — descPreset is a single byte. */
export const MIN_RING_SECONDS = 5;
export const MAX_RING_SECONDS = 180;

/**
 * A phone will not re-ring for the same caller inside this window, however many
 * times they press. Someone hammering the button must not be able to hold a
 * stranger's phone in a permanent alarm.
 */
export const BUZZ_COOLDOWN_MS = 20_000;

/** Forget a heard buzz after this long — it is over. */
export const BUZZ_STALE_MS = 5 * 60 * 1000;

/** A recorded press, either aimed at us or overheard. */
export interface BuzzRequest {
  /** Who pressed the button. */
  callerNodeId: number;
  /** Which node they want to ring, or BUZZ_ALL. */
  targetNodeId: number;
  /** The caller's position, or null when they had no fix. */
  lat: number | null;
  lon: number | null;
  seconds: number;
  /** Caller's Lamport clock: names the press, not the packet. */
  press: number;
  /** True when this phone is one of the phones being rung. */
  forMe: boolean;
  /** Relay distance the buzz travelled to reach us. */
  hops: number;
  at: number;
}

/** Somebody answering a buzz: "I am ringing, and I am here." */
export interface BuzzAnswer {
  responderNodeId: number;
  /** Who they are answering. */
  callerNodeId: number;
  /** The responder's own position, or null when they have no fix. */
  lat: number | null;
  lon: number | null;
  /** 0-100, or null when the phone did not say. */
  battery: number | null;
  hops: number;
  at: number;
}

export function clampRingSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_RING_SECONDS;
  return Math.min(MAX_RING_SECONDS, Math.max(MIN_RING_SECONDS, Math.round(seconds)));
}

/**
 * 0,0 is a real coordinate in the Gulf of Guinea and is also what a phone with
 * no fix sends. Treating it as a position would put every unlocated phone on
 * the same island, so it is read as "unknown" instead.
 */
export function positionOrNull(lat: number, lon: number): { lat: number | null; lon: number | null } {
  if (lat === 0 && lon === 0) return { lat: null, lon: null };
  return { lat, lon };
}

export function buzzFromPacket(packet: Packet, selfNodeId: number, at: number): BuzzRequest {
  const targetNodeId = packet.casualties;
  const pos = positionOrNull(packet.lat, packet.lon);
  return {
    callerNodeId: packet.originNodeId,
    targetNodeId,
    lat: pos.lat,
    lon: pos.lon,
    seconds: clampRingSeconds(packet.descPreset),
    press: packet.lamport,
    // A buzz never rings the phone that sent it, even when addressed to all.
    forMe:
      packet.originNodeId !== selfNodeId &&
      (targetNodeId === BUZZ_ALL || targetNodeId === selfNodeId),
    hops: packet.hops,
    at,
  };
}

export function answerFromPacket(packet: Packet, at: number): BuzzAnswer {
  const pos = positionOrNull(packet.lat, packet.lon);
  return {
    responderNodeId: packet.originNodeId,
    callerNodeId: packet.casualties,
    lat: pos.lat,
    lon: pos.lon,
    battery: packet.descPreset <= 100 ? packet.descPreset : null,
    hops: packet.hops,
    at,
  };
}

/** Stable name for one press of the button, invariant across relays. */
export function pressKey(callerNodeId: number, press: number): string {
  return `${callerNodeId}:${press}`;
}

/**
 * Decides whether an inbound buzz should actually make a noise.
 *
 * Two separate jobs, and conflating them is a bug:
 *   - a press already acted on must never ring twice, at any distance in time
 *   - a NEW press from a caller we rang for moments ago is rate-limited
 *
 * The first is correctness (echoes), the second is policy (abuse).
 */
export class BuzzGate {
  private acted = new Set<string>();
  private order: string[] = [];
  private lastRingByCaller = new Map<number, number>();

  constructor(
    private now: () => number = () => Date.now(),
    private cooldownMs = BUZZ_COOLDOWN_MS,
    private cap = 256
  ) {}

  /**
   * Returns true exactly once per press that is allowed to ring. Calling this
   * consumes the press either way — an echo of a rate-limited buzz must not
   * become ringable later just because the cooldown has since elapsed.
   */
  admit(buzz: BuzzRequest): boolean {
    const key = pressKey(buzz.callerNodeId, buzz.press);
    if (this.acted.has(key)) return false;
    this.remember(key);

    if (!buzz.forMe) return false;

    const last = this.lastRingByCaller.get(buzz.callerNodeId);
    const at = this.now();
    if (last != null && at - last < this.cooldownMs) return false;

    this.lastRingByCaller.set(buzz.callerNodeId, at);
    return true;
  }

  /** True if we have already dealt with this press. Does not consume it. */
  seen(buzz: BuzzRequest): boolean {
    return this.acted.has(pressKey(buzz.callerNodeId, buzz.press));
  }

  private remember(key: string): void {
    this.acted.add(key);
    this.order.push(key);
    while (this.order.length > this.cap) {
      const evicted = this.order.shift();
      if (evicted) this.acted.delete(evicted);
    }
  }
}

/** Wire-level guard so a corrupt byte cannot name a nonsense target. */
export function isBuzzCategory(category: number): boolean {
  return category === Category.BUZZ || category === Category.BUZZ_ACK;
}
