/**
 * Content-addressed packet identity.
 *
 *   packetId = sha256(lat_i32 || lon_i32 || category || originNodeId || timeBucket)[0..4]
 *
 * The 15-minute time bucket makes two reports of the same thing from the same
 * node collapse into one id automatically.
 *
 * Deliberately excludes every MUTABLE field (status, casualties, lamport): the
 * id has to stay stable across updates so a status change merges into the right
 * incident instead of creating a new one.
 */

import type { Category } from '../types';
import { latToI32, lonToI32 } from './codec';

export const TIME_BUCKET_MS = 15 * 60 * 1000;

/** Injected so this module stays pure — jest uses node:crypto, the app uses expo-crypto. */
export type Sha256Fn = (input: Uint8Array) => Uint8Array;

export function identityBytes(
  lat: number,
  lon: number,
  category: Category,
  originNodeId: number,
  epochMs: number
): Uint8Array {
  const buf = new Uint8Array(11);
  const view = new DataView(buf.buffer);
  view.setInt32(0, latToI32(lat), false);
  view.setInt32(4, lonToI32(lon), false);
  view.setUint8(8, category & 0xff);
  view.setUint8(9, originNodeId & 0xff);
  view.setUint8(10, Math.floor(epochMs / TIME_BUCKET_MS) & 0xff);
  return buf;
}

export function computePacketId(
  sha256: Sha256Fn,
  lat: number,
  lon: number,
  category: Category,
  originNodeId: number,
  epochMs: number
): number {
  const digest = sha256(identityBytes(lat, lon, category, originNodeId, epochMs));
  return (
    ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0
  );
}
