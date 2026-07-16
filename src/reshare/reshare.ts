/**
 * Proactive secret sharing — the HJKY (Herzberg–Jarecki–Krawczyk–Yung 1995)
 * share-refresh protocol, plus share redistribution to a new committee.
 *
 * This file is the lab's own inspectable teaching code. The primitives it
 * composes are CONSUMED, not rebuilt:
 *   - Shamir polynomial evaluation / Lagrange interpolation / randomness:
 *     src/reuse/shamir-math.ts (from crypto-lab-shamir-gate)
 *   - RFC 3526 group, Feldman commitments and share verification:
 *     src/reuse/vss.ts (from crypto-lab-vss-gate)
 *
 * SECURITY / CORRECTNESS INVARIANTS (the architecture embodies these):
 *   1. The secret is never an input to a reshare. Only shares and public
 *      commitments cross epoch boundaries; f(0) is never evaluated anywhere
 *      in dealZeroUpdate / applyReshare / redistribute.
 *   2. An honest update polynomial has constant term exactly 0, so the new
 *      sharing polynomial f'(x) = f(x) + sum(delta_i(x)) satisfies
 *      f'(0) = f(0): every share changes, the secret cannot.
 *   3. Verification is fail-closed and public: a dealing is accepted only if
 *      D_0 is the group identity AND every sub-share passes the Feldman check.
 *      applyReshare refuses (throws) on an unverified-bad dealing unless the
 *      caller explicitly opts into the "nobody checked" teaching path.
 *   4. Reconstruction never claims success on its own: callers must compare
 *      g^result against the public key Y — the raw interpolation output is
 *      always a well-formed field element, even for garbage mixtures.
 *   5. Duplicate x-coordinates are rejected before interpolation (division by
 *      zero in Lagrange), with an explanatory error.
 */

import {
  evalPoly,
  generateShares,
  lagrangeAt0,
  modInverse,
  randomBigInt,
} from '../reuse/shamir-math';
import {
  G,
  P,
  Q,
  feldmanCommitments,
  mod,
  modPow,
  verifyFeldmanShare,
} from '../reuse/vss';
import type {
  AdversaryRun,
  DealingVerdict,
  EpochState,
  RedistDealing,
  RedistVerdict,
  Steal,
  ZeroDealing,
} from './types';

export { G, P, Q };

/** Party display labels; x-coordinate of labels[j] is j + 1. */
export const PARTY_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

// ---------------------------------------------------------------------------
// Setup (a trusted dealer; DKG is a sibling lab, not rebuilt here)
// ---------------------------------------------------------------------------

/** Draw a random 256-bit secret scalar (an element of Z_q). */
export async function randomSecret(): Promise<bigint> {
  return randomBigInt(1n, 1n << 256n);
}

/**
 * Deal the initial t-of-n sharing of `secret` and publish its Feldman
 * commitments. commitments[0] = g^secret is the public key Y that every
 * later epoch must preserve.
 */
export async function initialDeal(secret: bigint, t: number, n: number): Promise<EpochState> {
  if (t < 2 || t > n) throw new Error('need 2 <= t <= n');
  const { shares, coefficients } = await generateShares(secret, t, n, Q);
  return {
    epoch: 1,
    n,
    t,
    shares: shares.map((s) => s.y),
    commitments: feldmanCommitments(coefficients),
  };
}

export function publicKey(state: EpochState): bigint {
  return state.commitments[0];
}

// ---------------------------------------------------------------------------
// Same-committee refresh (HJKY): zero-constant update polynomials
// ---------------------------------------------------------------------------

/**
 * One party's reshare dealing: a random degree-(t-1) polynomial delta with
 * delta(0) = 0, its Feldman commitments (D_0 = 1 by construction), and the
 * sub-shares delta(1..n).
 *
 * `cheatConstant` (teaching path only) plants a nonzero constant term — the
 * silent-secret-change attack that Feldman commitments exist to catch.
 * `coefficients` overrides randomness entirely for tests/KATs.
 */
export async function dealZeroUpdate(
  dealer: number,
  t: number,
  n: number,
  opts: { cheatConstant?: bigint; coefficients?: bigint[] } = {},
): Promise<ZeroDealing> {
  let coefficients: bigint[];
  if (opts.coefficients) {
    coefficients = opts.coefficients;
  } else {
    coefficients = [mod(opts.cheatConstant ?? 0n, Q)];
    for (let k = 1; k < t; k++) {
      // Leading coefficient nonzero so the update has degree exactly t-1,
      // mirroring generateShares in the consumed shamir-gate module.
      coefficients.push(await randomBigInt(k === t - 1 ? 1n : 0n, Q));
    }
  }
  const subShares: bigint[] = [];
  for (let j = 1; j <= n; j++) {
    subShares.push(evalPoly(coefficients, BigInt(j), Q));
  }
  return { dealer, coefficients, commitments: feldmanCommitments(coefficients), subShares };
}

/**
 * Public verification of a reshare dealing. Two independent checks:
 *   - zeroCommitmentOk: D_0 === 1 (the identity), i.e. delta(0) = 0 — the
 *     dealer is not smuggling a secret change;
 *   - subShareOk[j]: g^(subShare_j) equals the commitment evaluation at j+1
 *     (the Feldman check consumed from vss-gate) — the sub-share really lies
 *     on the committed polynomial.
 */
export function verifyDealing(dealing: ZeroDealing, n: number): DealingVerdict {
  const zeroCommitmentOk = dealing.commitments[0] === 1n;
  const subShareOk = dealing.subShares
    .slice(0, n)
    .map(
      (value, j) => verifyFeldmanShare({ participant: j + 1, value }, dealing.commitments).ok,
    );
  return {
    dealer: dealing.dealer,
    zeroCommitmentOk,
    subShareOk,
    ok: zeroCommitmentOk && subShareOk.every(Boolean),
  };
}

/**
 * Pure field arithmetic of the refresh: each party adds the sub-shares it
 * received to its existing share, mod q. Parametrised by q so the labelled
 * small-field illustration and its hand-computed KAT run the identical code.
 */
export function addSubShares(
  shares: bigint[],
  dealings: Array<{ subShares: bigint[] }>,
  q: bigint,
): bigint[] {
  return shares.map((share, j) => {
    let next = share;
    for (const d of dealings) {
      next = mod(next + d.subShares[j], q);
    }
    return next;
  });
}

/**
 * Turn the epoch: apply verified dealings to every share and fold the
 * dealers' commitments into the public commitments,
 *   C'_k = C_k * prod_i D_{i,k}  (mod p),
 * so C'_0 = C_0 * prod(1) = Y — the public key provably cannot move.
 *
 * Fail-closed: throws if any dealing fails verification, unless
 * `forceUnverified` (the "nobody checked" teaching path) is set.
 */
export function applyReshare(
  state: EpochState,
  dealings: ZeroDealing[],
  opts: { forceUnverified?: boolean } = {},
): EpochState {
  if (!opts.forceUnverified) {
    for (const d of dealings) {
      if (!verifyDealing(d, state.n).ok) {
        throw new Error(`dealing from party ${d.dealer + 1} failed verification`);
      }
    }
  }
  const commitments = state.commitments.map((c, k) => {
    let next = c;
    for (const d of dealings) {
      next = mod(next * d.commitments[k], P);
    }
    return next;
  });
  return {
    epoch: state.epoch + 1,
    n: state.n,
    t: state.t,
    shares: addSubShares(state.shares, dealings, Q),
    commitments,
  };
}

/** Run one full honest refresh round: every party deals, all verify, apply. */
export async function refreshEpoch(
  state: EpochState,
): Promise<{ next: EpochState; dealings: ZeroDealing[]; verdicts: DealingVerdict[] }> {
  const dealings: ZeroDealing[] = [];
  for (let i = 0; i < state.n; i++) {
    dealings.push(await dealZeroUpdate(i, state.t, state.n));
  }
  const verdicts = dealings.map((d) => verifyDealing(d, state.n));
  return { next: applyReshare(state, dealings), dealings, verdicts };
}

// ---------------------------------------------------------------------------
// Reconstruction and the (separate!) cryptographic check
// ---------------------------------------------------------------------------

export interface SharePoint {
  x: bigint;
  y: bigint;
}

/**
 * Lagrange interpolation at 0 over Z_q (consumed from shamir-gate), with the
 * one fail-closed guard interpolation itself cannot express: duplicate
 * x-coordinates make the Lagrange denominator zero.
 */
export function reconstruct(points: SharePoint[], q: bigint = Q): bigint {
  const seen = new Set<string>();
  for (const pt of points) {
    const key = pt.x.toString();
    if (seen.has(key)) {
      throw new Error(
        `duplicate x-coordinate ${key}: Lagrange divides by (x_i - x_j), which is zero here — the same party cannot appear twice`,
      );
    }
    seen.add(key);
  }
  return lagrangeAt0(points, q);
}

/**
 * The in-model correctness check a real system uses: does the candidate
 * scalar match the public key? This is a cryptographic FACT about the value,
 * deliberately separate from any security verdict about how it was obtained.
 */
export function matchesPublicKey(candidate: bigint, y: bigint): boolean {
  return modPow(G, mod(candidate, Q), P) === y;
}

// ---------------------------------------------------------------------------
// Membership change: redistribute t-of-n to a t'-of-n' committee
// ---------------------------------------------------------------------------

/** Lagrange coefficients lambda_i at x = 0 for the given x-coordinates. */
export function lagrangeCoeffsAtZero(xs: bigint[], q: bigint): bigint[] {
  return xs.map((xi, i) => {
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < xs.length; j++) {
      if (j === i) continue;
      num = mod(num * mod(-xs[j], q), q);
      den = mod(den * mod(xi - xs[j], q), q);
    }
    return mod(num * modInverse(den, q), q);
  });
}

/** Evaluate a commitment vector at x: prod_k C_k^(x^k) — g^(f(x)) publicly. */
export function commitmentEval(commitments: bigint[], x: bigint): bigint {
  let acc = 1n;
  let power = 1n;
  for (const c of commitments) {
    acc = mod(acc * modPow(c, power, P), P);
    power = mod(power * x, Q);
  }
  return acc;
}

/**
 * Redistribute the secret from a t-quorum of the old committee to a fresh
 * newT-of-newN committee. Each quorum member i deals g_i of degree newT-1
 * with g_i(0) = s_i (their own share — never the secret). New party j sets
 *   s'_j = sum_i lambda_i * g_i(j)   (mod q),
 * and the new public commitments are C'_k = prod_i D_{i,k}^(lambda_i), so
 * C'_0 = g^(sum lambda_i s_i) = g^secret = Y: same key, new committee.
 */
export async function redistribute(
  state: EpochState,
  quorum: number[],
  newT: number,
  newN: number,
): Promise<{
  next: EpochState;
  dealings: RedistDealing[];
  verdicts: RedistVerdict[];
  lambdas: bigint[];
}> {
  if (quorum.length !== state.t) throw new Error(`quorum must have exactly t = ${state.t} members`);
  if (newT < 2 || newT > newN) throw new Error('need 2 <= newT <= newN');

  const dealings: RedistDealing[] = [];
  for (const i of quorum) {
    const coefficients: bigint[] = [state.shares[i]];
    for (let k = 1; k < newT; k++) {
      coefficients.push(await randomBigInt(k === newT - 1 ? 1n : 0n, Q));
    }
    const subShares: bigint[] = [];
    for (let j = 1; j <= newN; j++) {
      subShares.push(evalPoly(coefficients, BigInt(j), Q));
    }
    dealings.push({ dealer: i, coefficients, commitments: feldmanCommitments(coefficients), subShares });
  }

  // Public verification: D_0 must equal g^(s_i), which anyone can compute
  // from the OLD commitments as commitmentEval(C, x_i) — no share revealed.
  const verdicts: RedistVerdict[] = dealings.map((d) => {
    const constantTermOk =
      d.commitments[0] === commitmentEval(state.commitments, BigInt(d.dealer + 1));
    const subShareOk = d.subShares.map(
      (value, j) => verifyFeldmanShare({ participant: j + 1, value }, d.commitments).ok,
    );
    return { dealer: d.dealer, constantTermOk, subShareOk, ok: constantTermOk && subShareOk.every(Boolean) };
  });
  for (const v of verdicts) {
    if (!v.ok) throw new Error(`redistribution dealing from party ${v.dealer + 1} failed verification`);
  }

  const lambdas = lagrangeCoeffsAtZero(
    quorum.map((i) => BigInt(i + 1)),
    Q,
  );

  const shares: bigint[] = [];
  for (let j = 0; j < newN; j++) {
    let s = 0n;
    for (let d = 0; d < dealings.length; d++) {
      s = mod(s + lambdas[d] * dealings[d].subShares[j], Q);
    }
    shares.push(s);
  }

  const commitments: bigint[] = [];
  for (let k = 0; k < newT; k++) {
    let c = 1n;
    for (let d = 0; d < dealings.length; d++) {
      c = mod(c * modPow(dealings[d].commitments[k], lambdas[d], P), P);
    }
    commitments.push(c);
  }

  return {
    next: { epoch: state.epoch + 1, n: newN, t: newT, shares, commitments },
    dealings,
    verdicts,
    lambdas,
  };
}

// ---------------------------------------------------------------------------
// The mobile adversary (why proactive resharing exists)
// ---------------------------------------------------------------------------

/**
 * Simulate `totalEpochs` epochs of a t-of-n sharing; between epochs the
 * committee either refreshes (reshareOn) or does nothing. The attacker copies
 * one party's CURRENT share at each steal point, then interpolates the loot.
 *
 * The result reports the cryptographic fact (does g^result equal Y?) and the
 * raw values; rendering a VERDICT about it is the UI's job — deliberately.
 */
export async function runMobileAdversary(
  reshareOn: boolean,
  steals: Steal[],
  totalEpochs: number,
  t = 3,
  n = 5,
): Promise<AdversaryRun> {
  const secret = await randomSecret();
  let state = await initialDeal(secret, t, n);
  const y = publicKey(state);
  const collected: AdversaryRun['collected'] = [];

  for (let epoch = 1; epoch <= totalEpochs; epoch++) {
    for (const s of steals) {
      if (s.epoch === epoch) {
        collected.push({ epoch, party: s.party, value: state.shares[s.party] });
      }
    }
    if (epoch < totalEpochs && reshareOn) {
      // Timeline runs skip per-dealing re-verification for speed; the honest
      // dealing path is verified exhaustively in refreshEpoch and the tests.
      const dealings: ZeroDealing[] = [];
      for (let i = 0; i < n; i++) {
        dealings.push(await dealZeroUpdate(i, t, n));
      }
      state = applyReshare(state, dealings, { forceUnverified: true });
    } else if (epoch < totalEpochs) {
      state = { ...state, epoch: state.epoch + 1 };
    }
  }

  // The attacker's best move: a single epoch that yielded >= t shares is a
  // clean quorum on one polynomial — interpolate just that. Otherwise the
  // loot has no usable subset and interpolating all of it is as good (bad)
  // as anything.
  const byEpoch = new Map<number, AdversaryRun['collected']>();
  for (const c of collected) {
    const group = byEpoch.get(c.epoch) ?? [];
    group.push(c);
    byEpoch.set(c.epoch, group);
  }
  let bestGroup: AdversaryRun['collected'] | null = null;
  for (const group of byEpoch.values()) {
    if (group.length >= t && (!bestGroup || group.length > bestGroup.length)) bestGroup = group;
  }
  const used = bestGroup ?? collected;

  const reconstructed = reconstruct(
    used.map((c) => ({ x: BigInt(c.party + 1), y: c.value })),
  );
  return {
    reshareOn,
    totalEpochs,
    steals,
    collected,
    used,
    reconstructed,
    matchesPublicKey: matchesPublicKey(reconstructed, y),
    publicKey: y,
    secret,
  };
}
