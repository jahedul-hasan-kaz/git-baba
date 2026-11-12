import * as crypto from 'node:crypto';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { blake2b, encryptSecretForGitHub, sealedBox, sealedBoxOpen } from '../src/main/security/sealedBox';

describe('BLAKE2b', () => {
  it('matches Node blake2b512 for 64-byte digests, across block boundaries', () => {
    for (const len of [0, 1, 3, 64, 127, 128, 129, 255, 256, 257, 1000]) {
      const input = crypto.randomBytes(len);
      expect(Buffer.from(blake2b(input, 64)).toString('hex')).toBe(crypto.createHash('blake2b512').update(input).digest('hex'));
    }
  });

  it('matches the RFC 7693 "abc" vector', () => {
    expect(Buffer.from(blake2b(Buffer.from('abc'), 64)).toString('hex')).toBe(
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    );
  });

  it('uses the output length in the parameter block (not a truncation)', () => {
    const a = blake2b(Buffer.from('abc'), 24);
    expect(a.length).toBe(24);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(blake2b(Buffer.from('abc'), 64)).subarray(0, 24).toString('hex'));
  });
});

describe('sealed box', () => {
  it('round-trips and never reuses an ephemeral key', () => {
    const kp = nacl.box.keyPair();
    const msg = Buffer.from('super-secret-value ✓');
    const a = sealedBox(msg, kp.publicKey);
    const b = sealedBox(msg, kp.publicKey);
    expect(a.length).toBe(32 + 16 + msg.length);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(sealedBoxOpen(a, kp.publicKey, kp.secretKey)!).toString()).toBe('super-secret-value ✓');
    expect(sealedBoxOpen(a, nacl.box.keyPair().publicKey, kp.secretKey)).toBeNull();
  });

  it('encrypts GitHub secrets from a base64 public key', () => {
    const kp = nacl.box.keyPair();
    const out = encryptSecretForGitHub('token-123', Buffer.from(kp.publicKey).toString('base64'));
    expect(Buffer.from(sealedBoxOpen(Buffer.from(out, 'base64'), kp.publicKey, kp.secretKey)!).toString()).toBe('token-123');
  });
});
