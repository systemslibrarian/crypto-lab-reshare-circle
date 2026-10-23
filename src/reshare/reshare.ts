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
 *      f'(0) = f(0): the sharing is re-randomized, while the secret cannot
 *      change. A particular share can retain the same numeric value only in
 *      the negligible event that the aggregate update evaluates to zero there.
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

const MAX_PARTIES = 1024;

function isCommitteeSize(t: number, n: number): boolean {
  return (
    Number.isSafeInteger(t) &&
    Number.isSafeInteger(n) &&
    t >= 2 &&
    t <= n &&
    n <= MAX_PARTIES
  );
}

function assertCommitteeSize(t: number, n: number): void {
  if (!isCommitteeSize(t, n)) {
    throw new Error(`need safe integer committee sizes with 2 <= t <= n <= ${MAX_PARTIES}`);
  }
}

function isCanonicalScalar(value: unknown, q: bigint = Q): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value < q;
}

function isSubgroupElement(value: unknown): value is bigint {
  return (
    typeof value === 'bigint' &&
    value > 0n &&
    value < P &&
    modPow(value, Q, P) === 1n
  );
}

function assertEpochState(state: EpochState): void {
  if (
    !state ||
    !Number.isSafeInteger(state.epoch) ||
    state.epoch < 1 ||
    !isCommitteeSize(state.t, state.n) ||
    !Array.isArray(state.shares) ||
    state.shares.length !== state.n ||
    !state.shares.every((share) => isCanonicalScalar(share)) ||
    !Array.isArray(state.commitments) ||
    state.commitments.length !== state.t ||
    !state.commitments.every(isSubgroupElement) ||
    state.commitments[state.t - 1] === 1n
  ) {
    throw new Error('malformed epoch state');
  }

  for (let j = 0; j < state.n; j++) {
    if (
      !verifyFeldmanShare(
        { participant: j + 1, value: state.shares[j] },
        state.commitments,
      ).ok
    ) {
      throw new Error(`epoch share ${j + 1} does not match the public commitments`);
    }
  }
}

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
  assertCommitteeSize(t, n);
  if (!isCanonicalScalar(secret)) throw new Error('secret must be a canonical scalar in Z_q');
  const { shares, coefficients } = await generateShares(secret, t, n, Q);
  const state = {
    epoch: 1,
    n,
    t,
    shares: shares.map((s) => s.y),
    commitments: feldmanCommitments(coefficients),
  };
  assertEpochState(state);
  return state;
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
  assertCommitteeSize(t, n);
  if (!Number.isSafeInteger(dealer) || dealer < 0 || dealer >= n) {
    throw new Error('dealer must identify one member of the committee');
  }

  let coefficients: bigint[];
  if (opts.coefficients) {
    if (
      opts.coefficients.length !== t ||
      !opts.coefficients.every((coefficient) => isCanonicalScalar(coefficient))
    ) {
      throw new Error(`update polynomial must contain exactly ${t} canonical Z_q coefficients`);
    }
    coefficients = [...opts.coefficients];
  } else {
    if (opts.cheatConstant !== undefined && typeof opts.cheatConstant !== 'bigint') {
      throw new Error('cheatConstant must be a bigint');
    }
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
export function verifyDealing(dealing: ZeroDealing, n: number, t: number): DealingVerdict {
  const dealer = Number.isSafeInteger(dealing?.dealer) ? dealing.dealer : -1;
  const structureOk =
    isCommitteeSize(t, n) &&
    dealer >= 0 &&
    dealer < n &&
    Array.isArray(dealing.commitments) &&
    dealing.commitments.length === t &&
    dealing.commitments.every(isSubgroupElement) &&
    Array.isArray(dealing.subShares) &&
    dealing.subShares.length === n &&
    dealing.subShares.every((share) => isCanonicalScalar(share));
  const zeroCommitmentOk = structureOk && dealing.commitments[0] === 1n;
  const subShareOk = structureOk
    ? dealing.subShares.map(
        (value, j) =>
          verifyFeldmanShare({ participant: j + 1, value }, dealing.commitments).ok,
      )
    : Array.from({ length: isCommitteeSize(t, n) ? n : 0 }, () => false);
  return {
    dealer,
    structureOk,
    zeroCommitmentOk,
    subShareOk,
    ok: structureOk && zeroCommitmentOk && subShareOk.every(Boolean),
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
  if (typeof q !== 'bigint' || q <= 2n) throw new Error('field modulus must be greater than 2');
  if (!Array.isArray(shares) || !shares.every((share) => isCanonicalScalar(share, q))) {
    throw new Error('shares must be canonical field elements');
  }
  if (
    !Array.isArray(dealings) ||
    dealings.some(
      (dealing) =>
        !Array.isArray(dealing?.subShares) ||
        dealing.subShares.length !== shares.length ||
        !dealing.subShares.every((share) => isCanonicalScalar(share, q)),
    )
  ) {
    throw new Error('each dealing must contain one canonical sub-share per receiver');
  }
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
 * Fail-closed: throws if any dealing has the wrong shape, repeats a dealer, or
 * fails either verification check. The deliberately unsafe counterfactual is
 * exposed under a separate, unmistakable function below rather than as an
 * option a production caller could set accidentally.
 */
export function applyReshare(
  state: EpochState,
  dealings: ZeroDealing[],
): EpochState {
  return applyReshareCore(state, dealings, true);
}

/**
 * Teaching-only counterfactual used by the "nobody checked" exhibit. It still
 * enforces canonical lengths and encodings so malformed objects cannot turn a
 * controlled secret-shift demonstration into an unrelated runtime failure.
 */
export function applyUnverifiedReshareForDemo(
  state: EpochState,
  dealings: ZeroDealing[],
): EpochState {
  return applyReshareCore(state, dealings, false);
}

function applyReshareCore(
  state: EpochState,
  dealings: ZeroDealing[],
  requireVerification: boolean,
): EpochState {
  assertEpochState(state);
  if (!Array.isArray(dealings) || dealings.length === 0 || dealings.length > state.n) {
    throw new Error(`reshare needs between 1 and ${state.n} distinct dealings`);
  }

  const dealers = new Set<number>();
  for (const dealing of dealings) {
    const verdict = verifyDealing(dealing, state.n, state.t);
    if (!verdict.structureOk) {
      throw new Error(`dealing from party ${verdict.dealer + 1} has malformed protocol data`);
    }
    if (dealers.has(dealing.dealer)) {
      throw new Error(`duplicate dealing from party ${dealing.dealer + 1}`);
    }
    dealers.add(dealing.dealer);
    if (requireVerification && !verdict.ok) {
      throw new Error(`dealing from party ${dealing.dealer + 1} failed verification`);
    }
  }

  const aggregateUpdate = state.commitments.map((_, k) => {
    let next = 1n;
    for (const d of dealings) {
      next = mod(next * d.commitments[k], P);
    }
    return next;
  });
  if (aggregateUpdate.slice(1).every((commitment) => commitment === 1n)) {
    throw new Error('dealings cancel to a zero update; retry instead of advancing an unchanged epoch');
  }

  const commitments = state.commitments.map(
    (commitment, k) => mod(commitment * aggregateUpdate[k], P),
  );
  if (commitments[state.t - 1] === 1n) {
    throw new Error('reshare cancelled the leading coefficient; retry to preserve the threshold');
  }

  const next = {
    epoch: state.epoch + 1,
    n: state.n,
    t: state.t,
    shares: addSubShares(state.shares, dealings, Q),
    commitments,
  };
  assertEpochState(next);
  return next;
}

/** Run one full honest refresh round: every party deals, all verify, apply. */
export async function refreshEpoch(
  state: EpochState,
): Promise<{ next: EpochState; dealings: ZeroDealing[]; verdicts: DealingVerdict[] }> {
  const dealings: ZeroDealing[] = [];
  for (let i = 0; i < state.n; i++) {
    dealings.push(await dealZeroUpdate(i, state.t, state.n));
  }
  const verdicts = dealings.map((d) => verifyDealing(d, state.n, state.t));
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
  if (typeof q !== 'bigint' || q <= 2n) throw new Error('field modulus must be greater than 2');
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('at least one share point is required');
  }
  const seen = new Set<string>();
  for (const pt of points) {
    if (!pt || !isCanonicalScalar(pt.x, q) || pt.x === 0n || !isCanonicalScalar(pt.y, q)) {
      throw new Error('share points must use nonzero canonical x and canonical y values');
    }
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
  if (typeof q !== 'bigint' || q <= 2n) throw new Error('field modulus must be greater than 2');
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('at least one x-coordinate is required');
  const seen = new Set<string>();
  for (const x of xs) {
    if (!isCanonicalScalar(x, q) || x === 0n) {
      throw new Error('x-coordinates must be nonzero canonical field elements');
    }
    const key = x.toString();
    if (seen.has(key)) throw new Error(`duplicate x-coordinate ${key}`);
    seen.add(key);
  }
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
  if (
    !Array.isArray(commitments) ||
    commitments.length === 0 ||
    !commitments.every(isSubgroupElement)
  ) {
    throw new Error('commitments must be nonempty canonical subgroup elements');
  }
  if (!isCanonicalScalar(x) || x === 0n) {
    throw new Error('commitment index must be a nonzero canonical field element');
  }
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
  assertEpochState(state);
  assertCommitteeSize(newT, newN);
  if (!Array.isArray(quorum)) throw new Error('quorum must be an array');
  if (quorum.length !== state.t) throw new Error(`quorum must have exactly t = ${state.t} members`);
  const uniqueQuorum = new Set<number>();
  for (const member of quorum) {
    if (!Number.isSafeInteger(member) || member < 0 || member >= state.n) {
      throw new Error('quorum contains a member outside the old committee');
    }
    if (uniqueQuorum.has(member)) throw new Error(`quorum repeats member ${member + 1}`);
    uniqueQuorum.add(member);
  }

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

  if (commitments[newT - 1] === 1n) {
    throw new Error('redistribution cancelled the leading coefficient; retry to preserve the new threshold');
  }

  const next = { epoch: state.epoch + 1, n: newN, t: newT, shares, commitments };
  assertEpochState(next);
  return {
    next,
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
  assertCommitteeSize(t, n);
  if (!Number.isSafeInteger(totalEpochs) || totalEpochs < 1 || totalEpochs > 1000) {
    throw new Error('totalEpochs must be a safe integer between 1 and 1000');
  }
  if (!Array.isArray(steals) || steals.length === 0) {
    throw new Error('at least one theft must be supplied');
  }
  const seenSteals = new Set<string>();
  for (const steal of steals) {
    if (
      !steal ||
      !Number.isSafeInteger(steal.epoch) ||
      steal.epoch < 1 ||
      steal.epoch > totalEpochs ||
      !Number.isSafeInteger(steal.party) ||
      steal.party < 0 ||
      steal.party >= n
    ) {
      throw new Error('each theft must name a valid epoch and committee member');
    }
    const key = `${steal.epoch}:${steal.party}`;
    if (seenSteals.has(key)) throw new Error(`duplicate theft ${key}`);
    seenSteals.add(key);
  }

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
      const dealings: ZeroDealing[] = [];
      for (let i = 0; i < n; i++) {
        dealings.push(await dealZeroUpdate(i, t, n));
      }
      state = applyReshare(state, dealings);
    } else if (epoch < totalEpochs) {
      state = { ...state, epoch: state.epoch + 1 };
    }
  }

  // Choose the strongest coherent interpolation attempt, computed rather than
  // assumed.
  //
  //   1. Group the loot by epoch. Shares stolen inside one epoch all lie on
  //      that epoch's single polynomial, so the largest such group is the only
  //      coherent quorum candidate; if it reaches t, that group alone recovers
  //      the secret and nothing else the attacker holds is needed.
  //   2. If no epoch reached t, nothing recovers the secret, and the attacker
  //      feeds Lagrange the widest set it CAN: interpolation divides by
  //      (x_i − x_j), so two copies of the SAME custodian can never both go in.
  //      Seed with the largest same-epoch group, then top up with one copy of
  //      each custodian not already represented. This is an illustrative
  //      cross-epoch attempt, not an exhaustive search for negligible random
  //      interpolation collisions; the separate public-key check still reports
  //      the exact result of the attempt.
  //
  // Collapsing repeat custodians BEFORE the epoch grouping models a strictly
  // weaker attacker and produces a false verdict: a plan holding A@1, A@5, B@1
  // and C@1 would keep only the newest copy of A, lose the epoch-1 quorum, and
  // report a cross-epoch HELD verdict about an
  // attacker who in fact holds A@1, B@1, C@1 and the key. An attacker never
  // discards a share it already copied — storage is free.
  const byEpoch = new Map<number, AdversaryRun['collected']>();
  for (const c of collected) {
    const group = byEpoch.get(c.epoch) ?? [];
    group.push(c);
    byEpoch.set(c.epoch, group);
  }
  let bestGroup: AdversaryRun['collected'] = [];
  for (const group of byEpoch.values()) {
    if (group.length > bestGroup.length) bestGroup = group;
  }
  let used: AdversaryRun['collected'];
  if (bestGroup.length >= t) {
    used = bestGroup;
  } else {
    used = [...bestGroup];
    const represented = new Set(bestGroup.map((c) => c.party));
    for (const c of collected) {
      if (represented.has(c.party)) continue;
      represented.add(c.party);
      used.push(c);
    }
  }

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
