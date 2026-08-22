import {
  PACKET_SIZE,
  decodePacket,
  encodePacket,
  packNibbles,
  unpackHi,
  unpackLo,
  latToI32,
  i32ToCoord,
} from '../src/proto/codec';
import type { Packet } from '../src/types';

function randomPacket(): Packet {
  return {
    packetId: Math.floor(Math.random() * 0xffffffff) >>> 0,
    lat: Math.random() * 180 - 90,
    lon: Math.random() * 360 - 180,
    category: Math.floor(Math.random() * 8) as Packet['category'],
    triage: Math.floor(Math.random() * 5) as Packet['triage'],
    casualties: Math.floor(Math.random() * 256),
    ttl: Math.floor(Math.random() * 8),
    hops: Math.floor(Math.random() * 16),
    lamport: Math.floor(Math.random() * 0xffff),
    status: Math.floor(Math.random() * 4) as Packet['status'],
    descPreset: Math.floor(Math.random() * 33),
    originNodeId: Math.floor(Math.random() * 256),
  };
}

describe('codec', () => {
  it('encodes to exactly 20 bytes', () => {
    expect(encodePacket(randomPacket()).length).toBe(PACKET_SIZE);
  });

  it('round-trips 10k random packets', () => {
    for (let i = 0; i < 10_000; i++) {
      const p = randomPacket();
      const decoded = decodePacket(encodePacket(p));
      expect(decoded).not.toBeNull();
      expect(decoded!.packetId).toBe(p.packetId);
      expect(decoded!.category).toBe(p.category);
      expect(decoded!.triage).toBe(p.triage);
      expect(decoded!.casualties).toBe(p.casualties);
      expect(decoded!.ttl).toBe(p.ttl);
      expect(decoded!.hops).toBe(p.hops);
      expect(decoded!.lamport).toBe(p.lamport);
      expect(decoded!.status).toBe(p.status);
      expect(decoded!.descPreset).toBe(p.descPreset);
      expect(decoded!.originNodeId).toBe(p.originNodeId);
      // 1e6 fixed point => sub-metre accuracy
      expect(Math.abs(decoded!.lat - p.lat)).toBeLessThan(1e-6);
      expect(Math.abs(decoded!.lon - p.lon)).toBeLessThan(1e-6);
    }
  });

  it('handles boundary coordinates', () => {
    const cases = [
      [0, 0],
      [90, 180],
      [-90, -180],
      [28.613912, 77.209021],
    ];
    for (const [lat, lon] of cases) {
      const p = { ...randomPacket(), lat, lon };
      const d = decodePacket(encodePacket(p))!;
      expect(d.lat).toBeCloseTo(lat, 5);
      expect(d.lon).toBeCloseTo(lon, 5);
    }
  });

  it('rejects malformed buffers instead of throwing', () => {
    expect(decodePacket(new Uint8Array(0))).toBeNull();
    expect(decodePacket(new Uint8Array(19))).toBeNull();
    expect(decodePacket(new Uint8Array(21))).toBeNull();
    expect(decodePacket(null as never)).toBeNull();
  });

  it('rejects out-of-range status and triage', () => {
    const bytes = encodePacket(randomPacket());
    bytes[17] = 9; // impossible status
    expect(decodePacket(bytes)).toBeNull();

    const b2 = encodePacket(randomPacket());
    b2[12] = packNibbles(0, 9); // impossible triage
    expect(decodePacket(b2)).toBeNull();
  });

  it('packs nibbles without bleeding across fields', () => {
    for (let hi = 0; hi < 16; hi++) {
      for (let lo = 0; lo < 16; lo++) {
        const b = packNibbles(hi, lo);
        expect(unpackHi(b)).toBe(hi);
        expect(unpackLo(b)).toBe(lo);
        expect(b).toBeLessThan(256);
      }
    }
  });

  it('clamps impossible coordinates rather than wrapping', () => {
    expect(i32ToCoord(latToI32(999))).toBe(90);
    expect(i32ToCoord(latToI32(-999))).toBe(-90);
  });
});
