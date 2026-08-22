/**
 * PATROL/1 wire codec — exactly 20 bytes, big-endian.
 *
 * The whole point of this format is that it fits inside a single BLE legacy
 * advertisement. 31 bytes total, minus 3 for flags and 4 for the manufacturer
 * data header/company id, leaves ~24 usable. We use 20.
 *
 *  off size field
 *   0   4   packetId      u32
 *   4   4   lat           i32  degrees * 1e6
 *   8   4   lon           i32  degrees * 1e6
 *  12   1   category:4 | triage:4
 *  13   1   casualties    u8
 *  14   1   ttl:4 | hops:4
 *  15   2   lamport       u16
 *  17   1   status        u8
 *  18   1   descPreset    u8
 *  19   1   originNodeId  u8
 */

import type { Category, Packet, Status, Triage } from '../types';

export const PACKET_SIZE = 20;

/** 0xFFFF is the Bluetooth SIG company id reserved for testing. */
export const MANUFACTURER_ID = 0xffff;

export const DEFAULT_TTL = 7;
export const MAX_HOPS = 15;

const COORD_SCALE = 1e6;

// ---------------------------------------------------------------------------
// Fixed-point coordinates
// ---------------------------------------------------------------------------

export function latToI32(lat: number): number {
  return Math.round(clamp(lat, -90, 90) * COORD_SCALE);
}

export function lonToI32(lon: number): number {
  return Math.round(clamp(lon, -180, 180) * COORD_SCALE);
}

export function i32ToCoord(v: number): number {
  return v / COORD_SCALE;
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// Nibble packing
// ---------------------------------------------------------------------------

export function packNibbles(hi: number, lo: number): number {
  return ((hi & 0x0f) << 4) | (lo & 0x0f);
}

export function unpackHi(byte: number): number {
  return (byte >> 4) & 0x0f;
}

export function unpackLo(byte: number): number {
  return byte & 0x0f;
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

export function encodePacket(p: Packet): Uint8Array {
  const buf = new Uint8Array(PACKET_SIZE);
  const view = new DataView(buf.buffer);

  view.setUint32(0, p.packetId >>> 0, false);
  view.setInt32(4, latToI32(p.lat), false);
  view.setInt32(8, lonToI32(p.lon), false);
  view.setUint8(12, packNibbles(p.category, p.triage));
  view.setUint8(13, clampByte(p.casualties));
  view.setUint8(14, packNibbles(p.ttl, Math.min(p.hops, MAX_HOPS)));
  view.setUint16(15, p.lamport & 0xffff, false);
  view.setUint8(17, clampByte(p.status));
  view.setUint8(18, clampByte(p.descPreset));
  view.setUint8(19, clampByte(p.originNodeId));

  return buf;
}

/**
 * Returns null on anything malformed. A bad advertisement from a stray beacon
 * must never crash a node, so this never throws.
 */
export function decodePacket(bytes: Uint8Array): Packet | null {
  if (!bytes || bytes.length !== PACKET_SIZE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const catTriage = view.getUint8(12);
  const category = unpackHi(catTriage) as Category;
  const triage = unpackLo(catTriage) as Triage;

  const ttlHops = view.getUint8(14);
  const status = view.getUint8(17) as Status;

  // Range checks — reject anything that cannot be a real PATROL packet.
  if (status > 3) return null;
  if (triage > 4) return null;

  const lat = i32ToCoord(view.getInt32(4, false));
  const lon = i32ToCoord(view.getInt32(8, false));
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return {
    packetId: view.getUint32(0, false),
    lat,
    lon,
    category,
    triage,
    casualties: view.getUint8(13),
    ttl: unpackHi(ttlHops),
    hops: unpackLo(ttlHops),
    lamport: view.getUint16(15, false),
    status,
    descPreset: view.getUint8(18),
    originNodeId: view.getUint8(19),
  };
}

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(255, Math.max(0, Math.round(v)));
}

// ---------------------------------------------------------------------------
// Debug helpers
// ---------------------------------------------------------------------------

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function shortId(packetId: number): string {
  return '0x' + (packetId >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
