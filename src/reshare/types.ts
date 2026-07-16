/**
 * Types for the proactive-resharing layer (HJKY 1995).
 *
 * Everything lives in the RFC 3526 group consumed from crypto-lab-vss-gate:
 * shares are elements of Z_q (the exponent field), commitments are elements
 * of the order-q subgroup of Z_p*. Party x-coordinates are 1..n.
 */

export interface EpochState {
  epoch: number;
  n: number;
  t: number;
  /** shares[j] is the share held by party with x = j + 1, an element of Z_q. */
  shares: bigint[];
  /**
   * Feldman commitments C_k = g^(a_k) to the current sharing polynomial.
   * commitments[0] = g^secret is the fixed public key Y.
   */
  commitments: bigint[];
}

/** One party's zero-constant update dealing for a same-committee reshare. */
export interface ZeroDealing {
  /** dealer party index, 0-based (x = dealer + 1) */
  dealer: number;
  /** update polynomial delta(x); coefficients[0] MUST be 0 for an honest dealer */
  coefficients: bigint[];
  /** D_k = g^(coefficients[k]); an honest dealing has D_0 = g^0 = 1 */
  commitments: bigint[];
  /** subShares[j] = delta(j + 1), sent privately to party j */
  subShares: bigint[];
}

export interface DealingVerdict {
  dealer: number;
  /** D_0 === 1, i.e. the dealer committed to a zero constant term */
  zeroCommitmentOk: boolean;
  /** Feldman check of each receiver's sub-share against the dealer's commitments */
  subShareOk: boolean[];
  ok: boolean;
}

/** One old-quorum member's dealing when resharing to a new committee. */
export interface RedistDealing {
  /** dealer party index in the OLD committee, 0-based (x = dealer + 1) */
  dealer: number;
  /** g_i(x) of degree newT - 1 with g_i(0) = s_i (the dealer's own share) */
  coefficients: bigint[];
  /** D_k = g^(coefficients[k]); D_0 must equal the dealer's public share value */
  commitments: bigint[];
  /** subShares[j] = g_i(j + 1) for each NEW party j */
  subShares: bigint[];
}

export interface RedistVerdict {
  dealer: number;
  /** D_0 matches g^(s_i) as computed publicly from the OLD epoch commitments */
  constantTermOk: boolean;
  subShareOk: boolean[];
  ok: boolean;
}

export interface Steal {
  /** 1-based epoch in which the attacker copies the share */
  epoch: number;
  /** 0-based party index */
  party: number;
}

export interface AdversaryRun {
  reshareOn: boolean;
  totalEpochs: number;
  steals: Steal[];
  /** the loot: for each steal, the share value the attacker walked away with */
  collected: Array<{ epoch: number; party: number; value: bigint }>;
  /**
   * What the attacker actually feeds the interpolator — their best move: if
   * any single epoch yielded >= t shares, that group alone; otherwise all of
   * the loot (which then spans epochs).
   */
  used: Array<{ epoch: number; party: number; value: bigint }>;
  /** Lagrange interpolation of `used` at x = 0 */
  reconstructed: bigint;
  /** g^reconstructed === Y — the cryptographic result, not the verdict */
  matchesPublicKey: boolean;
  publicKey: bigint;
  secret: bigint;
}
