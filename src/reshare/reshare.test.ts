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
  applyUnverifiedReshareForDemo,
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
    const verdict = verifyDealing(d, 5, 3);
    expect(verdict.structureOk).toBe(true);
    expect(verdict.zeroCommitmentOk).toBe(true);
    expect(verdict.subShareOk).toEqual([true, true, true, true, true]);
    expect(verdict.ok).toBe(true);
  });

  it('cheating dealing (constant term 7): zero-commitment check fails, sub-shares still self-consistent', async () => {
    const d = await dealZeroUpdate(2, 3, 5, { cheatConstant: 7n });
    const verdict = verifyDealing(d, 5, 3);
    expect(verdict.zeroCommitmentOk).toBe(false);
    // The lie is in the constant term, not the sub-shares: each sub-share DOES
    // lie on the committed polynomial. Only the D_0 = 1 check catches it.
    expect(verdict.subShareOk).toEqual([true, true, true, true, true]);
    expect(verdict.ok).toBe(false);
  });

  it('tampered sub-share fails the Feldman check for exactly that receiver', async () => {
    const d = await dealZeroUpdate(1, 3, 5);
    d.subShares[3] = mod(d.subShares[3] + 1n, Q);
    const verdict = verifyDealing(d, 5, 3);
    expect(verdict.zeroCommitmentOk).toBe(true);
    expect(verdict.subShareOk).toEqual([true, true, true, false, true]);
    expect(verdict.ok).toBe(false);
  });

  it('rejects a valid higher-degree dealing instead of silently invalidating the advertised threshold', async () => {
    const state = await initialDeal(SECRET, 3, 5);
    const degreeThree = await dealZeroUpdate(0, 4, 5, {
      coefficients: [0n, 2n, 3n, 4n],
    });
    const verdict = verifyDealing(degreeThree, 5, 3);
    expect(verdict.structureOk).toBe(false);
    expect(verdict.ok).toBe(false);
    expect(() => applyReshare(state, [degreeThree])).toThrow(/malformed protocol data/);
  });

  it('rejects truncated, extended, and non-canonical wire arrays', async () => {
    const d = await dealZeroUpdate(0, 3, 5);
    const truncated = { ...d, subShares: d.subShares.slice(0, 4) };
    const extended = { ...d, commitments: [...d.commitments, 1n] };
    const nonCanonical = { ...d, subShares: [Q, ...d.subShares.slice(1)] };

    for (const malformed of [truncated, extended, nonCanonical]) {
      const verdict = verifyDealing(malformed, 5, 3);
      expect(verdict.structureOk).toBe(false);
      expect(verdict.ok).toBe(false);
    }
  });

  it('returns a fail-closed verdict for a missing dealing object', () => {
    const verdict = verifyDealing(null as unknown as ZeroDealing, 5, 3);
    expect(verdict).toMatchObject({ dealer: -1, structureOk: false, ok: false });
    expect(verdict.subShareOk).toEqual([false, false, false, false, false]);
  });
});

describe('epoch refresh (HJKY)', () => {
  it('preserves the secret and public key, re-randomizes the sharing, and verifies every new share', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    const { next: e2, verdicts } = await refreshEpoch(e1);

    expect(verdicts.every((v) => v.ok)).toBe(true);
    expect(e2.epoch).toBe(2);
    for (const subset of subsetsOfSize([0, 1, 2, 3, 4], 3)) {
      expect(reconstruct(points(e2, subset))).toBe(SECRET);
    }
    expect(publicKey(e2)).toBe(publicKey(e1));
    const changed = e2.shares.filter((share, j) => share !== e1.shares[j]).length;
    // A nonzero degree-(t-1) update has at most t-1 roots, so at least
    // n-(t-1) share values must move; requiring all n would be mathematically
    // false even though a collision is negligible in the real field.
    expect(changed).toBeGreaterThanOrEqual(e2.n - e2.t + 1);
    for (let j = 0; j < 5; j++) {
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

  it('refuses an empty pseudo-refresh and duplicate dealer identities', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    const dealing = await dealZeroUpdate(0, 3, 5);
    expect(() => applyReshare(e1, [])).toThrow(/between 1 and 5 distinct dealings/);
    expect(() => applyReshare(e1, [dealing, dealing])).toThrow(/duplicate dealing/);
  });

  it('refuses a zero aggregate update instead of advancing an unchanged epoch', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    const noOp = await dealZeroUpdate(0, 3, 5, { coefficients: [0n, 0n, 0n] });
    expect(verifyDealing(noOp, 5, 3).ok).toBe(true);
    expect(() => applyReshare(e1, [noOp])).toThrow(/zero update/);

    const plus = await dealZeroUpdate(0, 3, 5, { coefficients: [0n, 2n, 3n] });
    const minus = await dealZeroUpdate(1, 3, 5, {
      coefficients: [0n, Q - 2n, Q - 3n],
    });
    expect(() => applyReshare(e1, [plus, minus])).toThrow(/zero update/);
  });

  it('allows the negligible case where one share receives a zero update', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    // delta(x) = x(x - 1), so delta(1) = 0 while the sharing still changes.
    const dealing = await dealZeroUpdate(0, 3, 5, {
      coefficients: [0n, Q - 1n, 1n],
    });
    const e2 = applyReshare(e1, [dealing]);
    expect(e2.shares[0]).toBe(e1.shares[0]);
    expect(e2.shares.slice(1)).not.toEqual(e1.shares.slice(1));
    expect(reconstruct(points(e2, [0, 1, 2]))).toBe(SECRET);
  });

  it('EXACT consequence of an unchecked cheat with constant c=7: secret shifts by exactly 7, public key by exactly g^7', async () => {
    const e1 = await initialDeal(SECRET, 3, 5);
    const dealings = [];
    for (let i = 0; i < 4; i++) dealings.push(await dealZeroUpdate(i, 3, 5));
    dealings.push(await dealZeroUpdate(4, 3, 5, { cheatConstant: 7n }));
    const e2 = applyUnverifiedReshareForDemo(e1, dealings);

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

  it('rejects empty and non-canonical reconstruction inputs', () => {
    expect(() => reconstruct([])).toThrow(/at least one share point/);
    expect(() => reconstruct([{ x: 0n, y: 1n }])).toThrow(/nonzero canonical x/);
    expect(() => reconstruct([{ x: 1n, y: Q }])).toThrow(/canonical y/);
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

  it('rejects repeated and out-of-range old committee members', async () => {
    const old = await initialDeal(SECRET, 3, 5);
    await expect(redistribute(old, [0, 0, 1], 4, 7)).rejects.toThrow(/repeats member/);
    await expect(redistribute(old, [0, 1, 5], 4, 7)).rejects.toThrow(/outside the old committee/);
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
    expect(run.used).toHaveLength(3); // no single epoch reached t: all loot used
    expect(run.reconstructed).not.toBe(run.secret);
    expect(run.matchesPublicKey).toBe(false);
  });

  it('HONEST LIMIT: with resharing ON but all three thefts inside one epoch, the key is still recovered', async () => {
    const sameEpoch = [
      { epoch: 2, party: 0 },
      { epoch: 2, party: 1 },
      { epoch: 2, party: 2 },
    ];
    const run = await runMobileAdversary(true, sameEpoch, 5);
    // Resharing resets the clock BETWEEN epochs; it cannot beat a quorum
    // assembled within one. The demo's UI states this — this test proves it.
    expect(run.reconstructed).toBe(run.secret);
    expect(run.matchesPublicKey).toBe(true);
  });

  it('prioritizes a full same-epoch quorum even with extra cross-epoch loot', async () => {
    const mixedPlan = [
      { epoch: 1, party: 3 }, // stray early theft, different polynomial
      { epoch: 4, party: 0 },
      { epoch: 4, party: 1 },
      { epoch: 4, party: 2 }, // epoch 4 alone reaches t = 3
    ];
    const run = await runMobileAdversary(true, mixedPlan, 5);
    expect(run.collected).toHaveLength(4);
    expect(run.used).toHaveLength(3);
    expect(run.used.every((c) => c.epoch === 4)).toBe(true);
    expect(run.matchesPublicKey).toBe(true);
  });

  it('two thefts stay below the threshold: never recovered, even without resharing', async () => {
    const run = await runMobileAdversary(false, [
      { epoch: 1, party: 0 },
      { epoch: 4, party: 1 },
    ], 5);
    expect(run.matchesPublicKey).toBe(false);
    expect(run.reconstructed).not.toBe(run.secret);
  });

  it('re-robbing a custodian never costs the attacker an earlier quorum', async () => {
    // The regression this pins: collapsing repeat custodians to their newest
    // copy BEFORE grouping by epoch throws away A@1, destroys the epoch-1
    // quorum, and reports a cross-epoch HELD result. The attacker keeps every
    // copy it took, so epoch 1 still holds A, B and C.
    const run = await runMobileAdversary(true, [
      { epoch: 1, party: 0 },
      { epoch: 1, party: 1 },
      { epoch: 1, party: 2 },
      { epoch: 5, party: 0 }, // A robbed a second time, four epochs later
    ], 5);
    expect(run.collected).toHaveLength(4);
    expect(run.used).toHaveLength(3);
    expect(run.used.every((c) => c.epoch === 1)).toBe(true);
    expect(run.reconstructed).toBe(run.secret);
    expect(run.matchesPublicKey).toBe(true);
  });

  it('robbing one custodian every epoch yields one usable point, not five', async () => {
    // Lagrange divides by (x_i − x_j), so the same custodian cannot be fed in
    // twice however often it is robbed. The run must resolve this itself
    // rather than handing duplicate x-coordinates to reconstruct().
    const run = await runMobileAdversary(
      true,
      [1, 2, 3, 4, 5].map((epoch) => ({ epoch, party: 0 })),
      5,
    );
    expect(run.collected).toHaveLength(5);
    expect(run.used).toHaveLength(1);
    expect(run.matchesPublicKey).toBe(false);
  });

  it('rejects malformed campaign coordinates instead of reading outside the committee', async () => {
    await expect(runMobileAdversary(true, [{ epoch: 0, party: 0 }], 5)).rejects.toThrow(
      /valid epoch and committee member/,
    );
    await expect(runMobileAdversary(true, [{ epoch: 1, party: 5 }], 5)).rejects.toThrow(
      /valid epoch and committee member/,
    );
    await expect(
      runMobileAdversary(true, [{ epoch: 1, party: 0 }, { epoch: 1, party: 0 }], 5),
    ).rejects.toThrow(/duplicate theft/);
  });
});

describe('assertEpochState rejects the malformed states it is there for', () => {
  /**
   * `publicKey`, `applyReshare` and `reconstruct` all run `assertEpochState`
   * first. Three of its checks had no test: dropping the subgroup membership
   * test, the degree test, or the `t >= 2` bound each left all 44 tests green.
   * These are the hostile shapes those three checks exist to refuse.
   */
  const valid = async () => initialDeal(SECRET, 3, 5);

  // `publicKey` does NOT validate — only `applyReshareCore` (reached through
  // `applyReshare` / `applyUnverifiedReshareForDemo`) and `redistribute` do.
  // Checked rather than assumed: the first version of these tests called
  // `publicKey` and nothing threw.
  const reshare = async (state: EpochState) => redistribute(state, [1, 2, 3], state.t, state.n);

  it('accepts the state a real deal produces', async () => {
    const state = await valid();
    await expect(reshare(state)).resolves.toBeDefined();
  });

  it('refuses a commitment outside the order-Q subgroup', async () => {
    const state = await valid();
    // 2 is a unit mod P but not in the subgroup of order Q, so 2^Q != 1. A
    // commitment there is not a g-power and Feldman verification is meaningless
    // against it.
    // Find an actual non-member rather than assuming one: with P = 2Q + 1 the
    // order-Q subgroup is the quadratic residues, and which small integers land
    // in it depends on P. (2 is a member here, which is why this is derived.)
    let outside = 2n;
    while (modPow(outside, Q, P) === 1n) outside += 1n;
    expect(modPow(outside, Q, P)).not.toBe(1n);
    const tampered = { ...state, commitments: [...state.commitments] };
    tampered.commitments[1] = outside;
    await expect(reshare(tampered)).rejects.toThrow(/malformed epoch state/);
  });

  it('refuses a commitment of zero or P, which are in no subgroup', async () => {
    const state = await valid();
    for (const bad of [0n, P, P + 1n]) {
      const tampered = { ...state, commitments: [...state.commitments] };
      tampered.commitments[1] = bad;
      await expect(reshare(tampered), String(bad)).rejects.toThrow(/malformed epoch state/);
    }
  });

  it('refuses a top commitment of 1, which claims a degree it does not have', async () => {
    const state = await valid();
    // g^0 = 1 as the leading commitment means the degree-(t-1) coefficient is
    // zero, so the polynomial is of lower degree than t-1 and t shares no
    // longer determine it. 1 IS in the subgroup, so only the explicit check
    // catches this.
    expect(modPow(1n, Q, P)).toBe(1n);
    const tampered = { ...state, commitments: [...state.commitments] };
    tampered.commitments[state.t - 1] = 1n;
    await expect(reshare(tampered)).rejects.toThrow(/malformed epoch state/);
  });

  // NOT guarded, and recorded rather than contrived: `t >= 2`, `t <= n` and the
  // safe-integer bounds inside `isCommitteeSize` are over-determined for any
  // state reachable through this API, because `assertEpochState` also requires
  // `commitments.length === t` and `shares.length === n` and verifies every
  // share against the commitments. A tampered `t` is therefore refused by a
  // length clause whether or not the bound is present, so a test cannot tell
  // which clause did it. Dropping each bound leaves the suite green, and a test
  // written to look like it isolated one would be asserting nothing. Same for
  // `value > 0n` in `isSubgroupElement`: 0^Q mod P is 0, so the subgroup test
  // already refuses zero.
  it("refuses the STATE's own committee sizes when they are not a sharing", async () => {
    const state = await valid();
    // The target sizes stay valid (3-of-5) so this exercises assertEpochState
    // rather than the argument check `assertCommitteeSize(newT, newN)`, which
    // raises a different error. The first version of this test passed for that
    // wrong reason — the sizes were being rejected as ARGUMENTS.
    const asState = async (patch: Partial<EpochState>) =>
      redistribute({ ...state, ...patch }, [1, 2, 3], 3, 5);

    // t = 1 is a "threshold" any single holder meets alone; t = 0 leaves the
    // commitment vector empty. Neither is a sharing. t > n cannot be met at
    // all, and a fractional n is not a committee.
    for (const patch of [{ t: 1 }, { t: 0 }, { t: -1 }, { t: state.n + 1 }, { n: 2.5 }]) {
      await expect(asState(patch), JSON.stringify(patch)).rejects.toThrow(
        /malformed epoch state|committee sizes/,
      );
    }
  });
});
