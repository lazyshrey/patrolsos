import { createHash } from 'node:crypto';
import { sha256 } from '../src/services/sha256';
import { computePacketId } from '../src/proto/packetId';
import { Category } from '../src/types';

const nodeSha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

describe('sha256', () => {
  it('matches node:crypto on known vectors', () => {
    const cases = ['', 'abc', 'P.A.T.R.O.L.', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(200)];
    for (const s of cases) {
      const input = new Uint8Array(Buffer.from(s, 'utf8'));
      expect(Buffer.from(sha256(input)).toString('hex')).toBe(
        createHash('sha256').update(input).digest('hex')
      );
    }
  });

  it('matches node:crypto on random buffers', () => {
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(Math.random() * 300);
      const input = new Uint8Array(len);
      for (let j = 0; j < len; j++) input[j] = Math.floor(Math.random() * 256);
      expect(Buffer.from(sha256(input)).toString('hex')).toBe(
        createHash('sha256').update(input).digest('hex')
      );
    }
  });
});

describe('packetId', () => {
  const args = [28.6139, 77.209, Category.MEDICAL, 7] as const;

  it('is stable inside a 15 minute bucket', () => {
    const base = 1_700_000_000_000;
    const a = computePacketId(sha256, ...args, base);
    const b = computePacketId(sha256, ...args, base + 60_000);
    expect(a).toBe(b);
  });

  it('changes across bucket boundaries', () => {
    const base = 1_700_000_000_000;
    const a = computePacketId(sha256, ...args, base);
    const b = computePacketId(sha256, ...args, base + 16 * 60_000);
    expect(a).not.toBe(b);
  });

  it('differs per originating node', () => {
    const base = 1_700_000_000_000;
    const a = computePacketId(sha256, 28.6139, 77.209, Category.MEDICAL, 7, base);
    const b = computePacketId(sha256, 28.6139, 77.209, Category.MEDICAL, 8, base);
    expect(a).not.toBe(b);
  });

  it('agrees with a node:crypto-backed implementation', () => {
    const base = 1_700_000_000_000;
    expect(computePacketId(sha256, ...args, base)).toBe(
      computePacketId(nodeSha, ...args, base)
    );
  });

  it('produces an unsigned 32-bit value', () => {
    for (let i = 0; i < 500; i++) {
      const id = computePacketId(sha256, Math.random() * 180 - 90, Math.random() * 360 - 180, Category.WATER, i % 255, Date.now() + i * 1e6);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(id)).toBe(true);
    }
  });
});
