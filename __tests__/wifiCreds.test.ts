import { BUCKET_MS, deriveWifiCreds } from '../src/services/wifiCreds';

describe('deriveWifiCreds', () => {
  const t = 1_700_000_000_000;

  it('two devices in the same bucket derive identical credentials', () => {
    const a = deriveWifiCreds(t);
    const b = deriveWifiCreds(t + 60_000); // clocks 1 min apart
    expect(a.networkName).toBe(b.networkName);
    expect(a.passphrase).toBe(b.passphrase);
  });

  it('rotates across day buckets', () => {
    const a = deriveWifiCreds(t);
    const b = deriveWifiCreds(t + BUCKET_MS);
    expect(a.networkName).not.toBe(b.networkName);
    expect(a.passphrase).not.toBe(b.passphrase);
  });

  it('network name satisfies the Android DIRECT- requirement', () => {
    expect(deriveWifiCreds(t).networkName.startsWith('DIRECT-')).toBe(true);
  });

  it('passphrase is a legal Wi-Fi length (8..63)', () => {
    for (let i = 0; i < 50; i++) {
      const p = deriveWifiCreds(t + i * BUCKET_MS).passphrase;
      expect(p.length).toBeGreaterThanOrEqual(8);
      expect(p.length).toBeLessThanOrEqual(63);
    }
  });

  it('network name stays within the 32-char SSID limit', () => {
    for (let i = 0; i < 50; i++) {
      expect(deriveWifiCreds(t + i * BUCKET_MS).networkName.length).toBeLessThanOrEqual(32);
    }
  });

  it('name and passphrase are different derivations', () => {
    const c = deriveWifiCreds(t);
    expect(c.networkName).not.toContain(c.passphrase);
  });

  it('is deterministic across calls', () => {
    expect(deriveWifiCreds(t)).toEqual(deriveWifiCreds(t));
  });
});
