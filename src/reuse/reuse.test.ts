/**
 * Known-answer tests proving the CONSUMED modules arrived intact.
 *
 * The Shamir vectors mirror crypto-lab-shamir-gate's own math.test.ts; the
 * group vectors mirror crypto-lab-vss-gate's vss.test.ts (RFC 3526 group 14).
 * If any of these fail, the reuse copy has drifted from its source — fix the
 * copy, never the vectors.
 */
import { describe, expect, it } from 'vitest';
import { evalPoly, lagrangeAt0, modInverse, modPow as shamirModPow } from './shamir-math';
import {
  G,
  P,
  Q,
  SMALL_G,
  SMALL_P,
  SMALL_Q,
  feldmanCommitments,
  mod,
  modPow,
  verifyFeldmanShare,
} from './vss';

const fermatProbablePrime = (n: bigint, bases: bigint[]): boolean =>
  bases.every((b) => modPow(b, n - 1n, n) === 1n);

describe('consumed shamir-gate math (KATs from its own suite)', () => {
  it('modPow KAT: 2^10 mod 1000 = 24', () => {
    expect(shamirModPow(2n, 10n, 1000n)).toBe(24n);
  });

  it('modPow KAT: x^0 = 1', () => {
    expect(shamirModPow(3n, 0n, 7n)).toBe(1n);
  });

  it('evalPoly KATs for f(x) = 2 + 3x + 4x^2 over GF(65537)', () => {
    expect(evalPoly([2n, 3n, 4n], 0n, 65537n)).toBe(2n);
    expect(evalPoly([2n, 3n, 4n], 1n, 65537n)).toBe(9n);
    expect(evalPoly([2n, 3n, 4n], 2n, 65537n)).toBe(24n);
  });

  it('lagrangeAt0 recovers f(0) = 42 for f(x) = 42 + 7x + 11x^2 over GF(65537)', () => {
    const p = 65537n;
    const points = [1n, 2n, 3n].map((x) => ({ x, y: evalPoly([42n, 7n, 11n], x, p) }));
    expect(points.map((pt) => pt.y)).toEqual([60n, 100n, 162n]);
    expect(lagrangeAt0(points, p)).toBe(42n);
  });

  it('modInverse: a * a^-1 = 1 mod p', () => {
    const p = 1019n;
    for (const a of [1n, 2n, 500n, 1018n]) {
      expect(mod(a * modInverse(a, p), p)).toBe(1n);
    }
  });
});

describe('consumed vss-gate group (RFC 3526 group 14 KATs)', () => {
  it('P is exactly 2048 bits and a safe prime: P = 2Q + 1', () => {
    expect(P.toString(2).length).toBe(2048);
    expect(P).toBe(2n * Q + 1n);
  });

  it('P and Q pass Fermat tests to bases 2 and 3', () => {
    expect(fermatProbablePrime(P, [2n, 3n])).toBe(true);
    expect(fermatProbablePrime(Q, [2n, 3n])).toBe(true);
  });

  it('P KAT: leading and trailing 64 bits match RFC 3526', () => {
    const hex = P.toString(16).toUpperCase();
    expect(hex.startsWith('FFFFFFFFFFFFFFFF')).toBe(true);
    expect(hex.endsWith('FFFFFFFFFFFFFFFF')).toBe(true);
  });

  it('G = 4 generates the order-Q subgroup', () => {
    expect(G).toBe(4n);
    expect(modPow(G, Q, P)).toBe(1n);
    expect(modPow(G, 1n, P)).not.toBe(1n);
  });

  it('small illustrative field: 2039 = 2*1019 + 1, both prime, G in subgroup', () => {
    expect(SMALL_P).toBe(2039n);
    expect(SMALL_Q).toBe(1019n);
    expect(SMALL_P).toBe(2n * SMALL_Q + 1n);
    expect(fermatProbablePrime(SMALL_P, [2n, 3n])).toBe(true);
    expect(fermatProbablePrime(SMALL_Q, [2n, 3n])).toBe(true);
    expect(modPow(SMALL_G, SMALL_Q, SMALL_P)).toBe(1n);
  });

  it('Feldman: honest share verifies, tampered share fails', () => {
    const coefficients = [5n, 7n, 11n];
    const commitments = feldmanCommitments(coefficients);
    expect(commitments[0]).toBe(modPow(G, 5n, P));
    const y3 = evalPoly(coefficients, 3n, Q);
    expect(verifyFeldmanShare({ participant: 3, value: y3 }, commitments).ok).toBe(true);
    expect(
      verifyFeldmanShare({ participant: 3, value: mod(y3 + 1n, Q) }, commitments).ok,
    ).toBe(false);
  });
});
