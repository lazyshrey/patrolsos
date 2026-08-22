/**
 * Deterministic Wi-Fi Direct credentials.
 *
 * Two phones that have never met must be able to form the same group without
 * exchanging anything. So instead of negotiating a passphrase, both DERIVE it:
 *
 *   networkName = "DIRECT-PA-" + sha256(SALT || dayBucket)[0..4]
 *   passphrase  =               sha256(SALT || dayBucket || "pw")[0..16]
 *
 * Rotating on a day bucket also stops the network name becoming a permanent
 * beacon: a stable SSID broadcast in the clear would let anyone with a laptop
 * log "a P.A.T.R.O.L. device was here at 14:02" indefinitely. One day is a
 * deliberate compromise — short enough to blunt long-term tracking, long enough
 * that two phones whose clocks disagree by minutes still agree on the bucket.
 *
 * SECURITY NOTE, stated plainly: this is obfuscation, not secrecy. The salt is
 * in the source of an open-source app, so anyone can derive the same
 * credentials and join. It stops accidental collisions with unrelated Wi-Fi
 * Direct groups; it does NOT authenticate peers. Packet-level signing is the
 * answer to that, and is a known gap (see PLAN.md section 10).
 */

import { sha256 } from './sha256';

const SALT = 'PATROL/1/wifi-direct';

/** Android requires the network name to begin with "DIRECT-". */
const PREFIX = 'DIRECT-PA-';

export const BUCKET_MS = 24 * 60 * 60 * 1000;

function hex(bytes: Uint8Array, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function digest(input: string): Uint8Array {
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i) & 0xff;
  return sha256(bytes);
}

export interface WifiCreds {
  networkName: string;
  passphrase: string;
  bucket: number;
}

export function deriveWifiCreds(epochMs: number = Date.now()): WifiCreds {
  const bucket = Math.floor(epochMs / BUCKET_MS);

  const nameDigest = digest(`${SALT}|${bucket}`);
  const pwDigest = digest(`${SALT}|${bucket}|pw`);

  return {
    networkName: PREFIX + hex(nameDigest, 4),
    // Wi-Fi passphrases must be 8..63 characters; 16 hex chars sits comfortably.
    passphrase: hex(pwDigest, 8),
    bucket,
  };
}
