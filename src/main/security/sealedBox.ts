// libsodium `crypto_box_seal`, which GitHub requires for secret values:
//   ciphertext = ephemeralPublicKey || crypto_box(message, nonce, recipientPublicKey, ephemeralSecretKey)
//   nonce      = BLAKE2b-192(ephemeralPublicKey || recipientPublicKey)
// crypto_box (X25519 + XSalsa20-Poly1305) comes from tweetnacl; BLAKE2b with a 24-byte digest is not in
// Node's crypto (only the fixed 64-byte variant), so it is implemented here (RFC 7693) and tested
// against Node's blake2b512.
import nacl from 'tweetnacl';

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK;

function readU64(b: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
  return v;
}

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const m = Array.from({ length: 16 }, (_, i) => readU64(block, i * 8));
  const v = [...h, ...IV];
  v[12] ^= t & MASK;
  v[13] ^= (t >> 64n) & MASK;
  if (last) v[14] ^= MASK;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a] + v[b] + x) & MASK;
    v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK;
    v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** Unkeyed BLAKE2b with a digest of `outLen` bytes (1–64). */
export function blake2b(input: Uint8Array, outLen: number): Uint8Array {
  if (outLen < 1 || outLen > 64) throw new RangeError('BLAKE2b output length must be 1–64 bytes');
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  let t = 0n;
  let off = 0;
  // All blocks but the last are compressed as non-final.
  while (input.length - off > 128) {
    t += 128n;
    compress(h, input.subarray(off, off + 128), t, false);
    off += 128;
  }
  const last = new Uint8Array(128);
  last.set(input.subarray(off));
  t += BigInt(input.length - off);
  compress(h, last, t, true);
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((h[i] >> BigInt(8 * j)) & 0xffn);
  return out.slice(0, outLen);
}

function sealNonce(epk: Uint8Array, pk: Uint8Array): Uint8Array {
  const both = new Uint8Array(64);
  both.set(epk);
  both.set(pk, 32);
  return blake2b(both, nacl.box.nonceLength);
}

/** Encrypts `message` for `recipientPublicKey` (32 bytes) — libsodium crypto_box_seal. */
export function sealedBox(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  if (recipientPublicKey.length !== nacl.box.publicKeyLength) throw new Error('Invalid public key length');
  const eph = nacl.box.keyPair();
  try {
    const boxed = nacl.box(message, sealNonce(eph.publicKey, recipientPublicKey), recipientPublicKey, eph.secretKey);
    const out = new Uint8Array(eph.publicKey.length + boxed.length);
    out.set(eph.publicKey);
    out.set(boxed, eph.publicKey.length);
    return out;
  } finally {
    eph.secretKey.fill(0);
  }
}

/** Opens a sealed box (used by tests to verify the format round-trips). */
export function sealedBoxOpen(sealed: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null {
  const epk = sealed.subarray(0, 32);
  return nacl.box.open(sealed.subarray(32), sealNonce(epk, publicKey), epk, secretKey);
}

/** GitHub secret helper: base64 sealed box of a UTF-8 value for a base64 repository/org/env public key. */
export function encryptSecretForGitHub(value: string, publicKeyB64: string): string {
  const pk = Uint8Array.from(Buffer.from(publicKeyB64, 'base64'));
  const msg = Uint8Array.from(Buffer.from(value, 'utf8'));
  try {
    return Buffer.from(sealedBox(msg, pk)).toString('base64');
  } finally {
    msg.fill(0);
  }
}
