/**
 * Tests for the HJKY proactive-resharing layer.
 *
 * Includes a fully deterministic hand-computed KAT over the labelled small
 * field GF(1019) (the same instance the UI's mechanism table shows), and the
 * exact-consequence tests the honesty constraints demand: a cheating dealer
 * with constant term c shifts the secret by exactly c and the public key by
 * exactly g^c — no more, no less.
 */
import { describe, expect, it } from 'vitest';
import { evalPoly } from '../reuse/shamir-math';
import { SMALL_Q, mod, modPow } from '../reuse/vss';
import {
  G,
  P,
  Q,
  addSubShares,
  applyReshare,
  commitmentEval,
  dealZeroUpdate,
  initialDeal,
  lagrangeCoeffsAtZero,
  matchesPublicKey,
  publicKey,
  reconstruct,
  redistribute,
  refreshEpoch,
  runMobileAdversary,
  verifyDealing,
} from './reshare';
import type { EpochState, ZeroDealing } from './types';

const SECRET = 0xdeadbeefcafef00d1234567890abcdefn;

function points(state: EpochState, idxs: number[]) {
  return idxs.map((j) => ({ x: BigInt(j + 1), y: state.shares[j] }));
}

function subsetsOfSize<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [head, ...rest] = arr;
  return [
    ...subsetsOfSize(rest, k - 1).map((s) => [head, ...s]),
    ...subsetsOfSize(rest, k),
  ];
}

describe('initial dealing (3-of-5 over Z_q)', () => {
  it('every 3-subset of the 5 shares reconstructs the secret; commitments[0] = g^s', async () => {
    const state = await initialDeal(SECRET, 3, 5);
    for (const subset of subsetsOfSize([0, 1, 2, 3, 4], 3)) {
      expect(reconstruct(points(state, subset))).toBe(SECRET);
    }
    expect(publicKey(state)).toBe(modPow(G, SECRET, P));
  });

  it('every initial share passes the Feldman check against the public commitments', async () => {
    const state = await initialDeal(SECRET, 3, 5);
    for (let j = 0; j < state.n; j++) {
      expect(commitmentEval(state.commitments, BigInt(j + 1))).toBe(
        modPow(G, state.shares[j], P),
      );
    }
  });

  it('t-1 shares interpolate to a value that is NOT the secret (guaranteed: leading coeff != 0)', async () => {
    const state = await initialDeal(SECRET, 3, 5);
    // Two points of a degree-2 polynomial determine a line; its value at 0 is
    // s - 2*a2, and a2 is drawn from [1, Q) — so this can never equal s.
    const below = reconstruct(points(state, [0, 1]));
    expect(below).not.toBe(SECRET);
    expect(matchesPublicKey(below, publicKey(state))).toBe(false);
  });
});

describe('zero-constant update dealings', () => {
  it('honest dealing: D_0 is the identity and all sub-shares verify', async () => {
    const d = await dealZeroUpdate(0, 3, 5);
    expect(d.coefficients[0]).toBe(0n);
    expect(d.commitments[0]).toBe(1n);
    const verdict = verifyDealing(d, 5);
    expect(verdict.zeroCommitmentOk).toBe(true);
    expect(verdict.subShareOk).toEqual([true, true, true, true, true]);
    expect(verdict.ok).toBe(true);
  });

  it('cheating dealing (constant term 7): zero-commitment check fails, sub-shares still self-consistent', async () => {
    const d = await dealZeroUpdate(2, 3, 5, { cheatConstant: 7n });
    const verdict = verifyDealing(d, 5);
    expect(verdict.zeroCommitmentOk).toBe(false);
    // The lie is in the constant term, not the sub-shares: each sub-share DOES
    // lie on the committed polynomial. Only the D_0 = 1 check catches it.
    expect(verdict.subShareOk).toEqual([true, true, true, true, true]);
    expect(verdict.ok).toBe(false);
  });

  it('tampered sub-share fails the Feldman check for exactly that receiver', async () => {
    const d = await dealZeroUpdate(1, 3, 5);
    d.subShares[3] = mod(d.subShares[3] + 1n, Q);
    const verdict = verifyDealing(d, 5);
    expect(verdict.zeroCommitmentOk).toBe(true);
    expect(verdict.subShareOk).toEqual([true, true, true, false, true]);
    expect(verdict.ok).toBe(false);
  });
});

describe('epoch refresh (HJKY)', () => {
  it('preserves the secret and the public key, changes every share, and new shares verify', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    const { next: e2, verdicts } = await refreshEpoch(e1);

    expect(verdicts.every((v) => v.ok)).toBe(true);
    expect(e2.epoch).toBe(2);
    for (const subset of subsetsOfSize([0, 1, 2, 3, 4], 3)) {
      expect(reconstruct(points(e2, subset))).toBe(SECRET);
    }
    expect(publicKey(e2)).toBe(publicKey(e1));
    for (let j = 0; j < 5; j++) {
      expect(e2.shares[j]).not.toBe(e1.shares[j]);
      expect(commitmentEval(e2.commitments, BigInt(j + 1))).toBe(modPow(G, e2.shares[j], P));
    }
  });

  it('applyReshare is fail-closed: a cheating dealing throws unless explicitly forced', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    const honest: ZeroDealing[] = [];
    for (let i = 0; i < 4; i++) honest.push(await dealZeroUpdate(i, 3, 5));
    const cheat = await dealZeroUpdate(4, 3, 5, { cheatConstant: 7n });
    expect(() => applyReshare(e1, [...honest, cheat])).toThrow(/failed verification/);
  });

  it('EXACT consequence of an unchecked cheat with constant c=7: secret shifts by exactly 7, public key by exactly g^7', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    const dealings = [];
    for (let i = 0; i < 4; i++) dealings.push(await dealZeroUpdate(i, 3, 5));
    dealings.push(await dealZeroUpdate(4, 3, 5, { cheatConstant: 7n }));
    const e2 = applyReshare(e1, dealings, { forceUnverified: true });

    expect(reconstruct(points(e2, [0, 1, 2]))).toBe(mod(SECRET + 7n, Q));
    expect(publicKey(e2)).toBe(mod(publicKey(e1) * modPow(G, 7n, P), P));
    expect(publicKey(e2)).not.toBe(publicKey(e1));
  });

  it('mixed-epoch shares interpolate to garbage: not the secret, g^result != Y', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    const { next: e2 } = await refreshEpoch(e1);
    const mixed = [
      { x: 1n, y: e1.shares[0] },
      { x: 2n, y: e2.shares[1] },
      { x: 3n, y: e2.shares[2] },
    ];
    const rec = reconstruct(mixed);
    expect(rec).not.toBe(SECRET);
    expect(matchesPublicKey(rec, publicKey(e1))).toBe(false);
  });

  it('duplicate x-coordinates (same party, two epochs) are rejected before interpolation', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    const { next: e2 } = await refreshEpoch(e1);
    expect(() =>
      reconstruct([
        { x: 1n, y: e1.shares[0] },
        { x: 1n, y: e2.shares[0] },
        { x: 3n, y: e2.shares[2] },
      ]),
    ).toThrow(/duplicate x-coordinate/);
  });
});

describe('hand-computed small-field KAT (GF(1019) — the UI mechanism table)', () => {
  // f(x) = 42 + 5x: shares f(1)=47, f(2)=52, f(3)=57.
  // Zero-constant updates: 3x, 10x, 1x → sums 14x at x=1,2,3 = 14, 28, 42.
  // New shares: 61, 80, 99. Reconstructions computed by hand.
  const q = SMALL_Q;
  const f = [42n, 5n];
  const deltas = [
    [0n, 3n],
    [0n, 10n],
    [0n, 1n],
  ];

  it('epoch-1 shares are 47, 52, 57 and any 2 reconstruct 42', () => {
    const shares = [1n, 2n, 3n].map((x) => evalPoly(f, x, q));
    expect(shares).toEqual([47n, 52n, 57n]);
    expect(reconstruct([{ x: 1n, y: 47n }, { x: 2n, y: 52n }], q)).toBe(42n);
    expect(reconstruct([{ x: 2n, y: 52n }, { x: 3n, y: 57n }], q)).toBe(42n);
  });

  it('adding the three zero-constant updates gives exactly 61, 80, 99 — and still reconstructs 42', () => {
    const shares = [47n, 52n, 57n];
    const dealings = deltas.map((coeffs) => ({
      subShares: [1n, 2n, 3n].map((x) => evalPoly(coeffs, x, q)),
    }));
    const next = addSubShares(shares, dealings, q);
    expect(next).toEqual([61n, 80n, 99n]);
    expect(reconstruct([{ x: 1n, y: 61n }, { x: 2n, y: 80n }], q)).toBe(42n);
    expect(reconstruct([{ x: 1n, y: 61n }, { x: 3n, y: 99n }], q)).toBe(42n);
  });

  it('mixing epochs reconstructs exactly 14 — deterministic garbage, not 42', () => {
    // Line through (1, 47) [epoch 1] and (2, 80) [epoch 2]: value at 0 is 2*47 - 80 = 14.
    expect(reconstruct([{ x: 1n, y: 47n }, { x: 2n, y: 80n }], q)).toBe(14n);
  });

  it('lagrangeCoeffsAtZero KAT: xs = 1,2,3 gives lambdas 3, -3, 1 mod q', () => {
    expect(lagrangeCoeffsAtZero([1n, 2n, 3n], q)).toEqual([3n, mod(-3n, q), 1n]);
  });
});

describe('membership change: redistribute 3-of-5 to 4-of-7', () => {
  it('same secret, same public key, new committee; old threshold no longer applies', async () => {
    const old = await initialDeal(SECRET, 3, 5);
    const { next, verdicts, lambdas } = await redistribute(old, [0, 1, 2], 4, 7);

    expect(verdicts.every((v) => v.ok)).toBe(true);
    expect(lambdas).toEqual(lagrangeCoeffsAtZero([1n, 2n, 3n], Q));
    expect(next.n).toBe(7);
    expect(next.t).toBe(4);

    // Public key preserved without the secret ever being reconstructed.
    expect(publicKey(next)).toBe(publicKey(old));

    // Any 4 of the 7 new shares reconstruct the same secret (spot-check 3 subsets).
    for (const subset of [[0, 1, 2, 3], [3, 4, 5, 6], [0, 2, 4, 6]]) {
      expect(reconstruct(points(next, subset))).toBe(SECRET);
    }

    // New shares verify against the NEW commitments.
    for (let j = 0; j < 7; j++) {
      expect(commitmentEval(next.commitments, BigInt(j + 1))).toBe(
        modPow(G, next.shares[j], P),
      );
    }

    // The new threshold is 4: three new shares are no longer enough.
    const below = reconstruct(points(next, [0, 1, 2]));
    expect(matchesPublicKey(below, publicKey(next))).toBe(false);
  });

  it('rejects a wrong-size quorum', async () => {
    const old = await initialDeal(SECRET, 3, 5);
    await expect(redistribute(old, [0, 1], 4, 7)).rejects.toThrow(/quorum/);
  });
});

describe('the mobile adversary (steal A@1, B@3, C@5 over 5 epochs, t=3)', () => {
  const steals = [
    { epoch: 1, party: 0 },
    { epoch: 3, party: 1 },
    { epoch: 5, party: 2 },
  ];

  it('WITHOUT resharing: three patient thefts recover the secret — g^result matches Y', async () => {
    const run = await runMobileAdversary(false, steals, 5);
    expect(run.collected).toHaveLength(3);
    expect(run.reconstructed).toBe(run.secret);
    expect(run.matchesPublicKey).toBe(true);
  });

  it('WITH resharing: the same three thefts interpolate to garbage — g^result does not match Y', async () => {
    const run = await runMobileAdversary(true, steals, 5);
    expect(run.collected).toHaveLength(3);
    expect(run.reconstructed).not.toBe(run.secret);
    expect(run.matchesPublicKey).toBe(false);
  });
});
