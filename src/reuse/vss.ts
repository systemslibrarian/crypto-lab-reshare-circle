/**
 * CONSUMED MODULE — do not fork the algebra here.
 *
 * Copied verbatim from crypto-lab-vss-gate (src/vss.ts):
 *   https://github.com/systemslibrarian/crypto-lab-vss-gate
 *   live demo: https://systemslibrarian.github.io/crypto-lab-vss-gate/
 *
 * This lab (crypto-lab-reshare-circle) uses the RFC 3526 group-14 parameters
 * (P, Q, G), the field/exponent helpers (mod, modPow), Feldman commitments and
 * share verification, and the labelled small illustrative field (SMALL_P,
 * SMALL_Q, SMALL_G). The ONLY changes from the source file are this header and
 * `export` added to three originally module-private functions so the reshare
 * layer can call them: evalPolynomial, feldmanCommitments, verifyFeldmanShare.
 * The Pedersen/trace exports are unused here — Feldman is this lab's verifier.
 */
export type ThemeMode = 'dark' | 'light';

export type Share = {
  participant: number;
  value: bigint;
};

export type PedersenShare = {
  participant: number;
  s: bigint;
  r: bigint;
};

export type FeldmanRun = {
  secret: bigint;
  threshold: number;
  participants: number;
  coefficients: bigint[];
  commitments: bigint[];
  shares: Share[];
  verification: Array<{ participant: number; lhs: bigint; rhs: bigint; ok: boolean }>;
  cheatedParticipant: number | null;
};

export type PedersenRun = {
  secret: bigint;
  threshold: number;
  participants: number;
  fCoefficients: bigint[];
  rCoefficients: bigint[];
  commitments: bigint[];
  shares: PedersenShare[];
  verification: Array<{ participant: number; lhs: bigint; rhs: bigint; ok: boolean }>;
  cheatedParticipant: number | null;
};

export type RunOptions = {
  deterministic?: boolean;
  seed?: string;
};

// RFC 3526 group 14 prime (2048-bit safe prime).
const PRIME_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74' +
  '020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437' +
  '4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05' +
  '98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB' +
  '9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718' +
  '3995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF';

export const mod = (value: bigint, modulus: bigint): bigint => {
  const r = value % modulus;
  return r >= 0n ? r : r + modulus;
};

export const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = mod(result * b, modulus);
    }
    e >>= 1n;
    b = mod(b * b, modulus);
  }
  return result;
};

export const P = BigInt(`0x${PRIME_HEX}`);
export const Q = (P - 1n) / 2n;

// Use a subgroup generator of order Q by squaring canonical g=2.
export const G = 4n;
export const H = deriveSecondGenerator();

const bytesToBigint = (bytes: Uint8Array): bigint => {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return BigInt(`0x${hex || '00'}`);
};


const hashStringToBigint = (input: string): bigint => {
  let acc = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i += 1) {
    acc ^= BigInt(input.charCodeAt(i));
    acc = mod(acc * prime, 1n << 64n);
  }
  return acc;
};

const randomBigintBelow = (modulus: bigint, deterministicRng?: () => bigint): bigint => {
  if (deterministicRng) {
    while (true) {
      const candidate = mod(deterministicRng(), modulus);
      if (candidate > 0n && candidate < modulus) {
        return candidate;
      }
    }
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const byteLength = Math.ceil(modulus.toString(2).length / 8);
    const bytes = new Uint8Array(byteLength);
    while (true) {
      crypto.getRandomValues(bytes);
      const candidate = bytesToBigint(bytes);
      if (candidate > 0n && candidate < modulus) {
        return candidate;
      }
    }
  }

  while (true) {
    const candidate = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    if (candidate > 0n && candidate < modulus) {
      return candidate;
    }
  }
};

const randomSeed = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `fallback-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
};

const normalizeRunOptions = (options?: RunOptions): { deterministic: boolean; seed: string } => ({
  deterministic: Boolean(options?.deterministic),
  seed: options?.seed ?? randomSeed()
});

const deriveDeterministicScalar = (seed: string, label: string, secret: bigint, i: number): bigint => {
  const h = hashStringToBigint(`${seed}|${label}|${secret.toString()}|${i}`);
  return mod(h, Q - 1n) + 1n;
};

const resolvePolynomial = (
  secret: bigint,
  threshold: number,
  label: string,
  options?: RunOptions
): bigint[] => {
  const run = normalizeRunOptions(options);
  if (!run.deterministic) {
    return buildRandomPolynomial(secret, threshold);
  }
  return buildDeterministicPolynomial(secret, threshold, label, run.seed);
};

function deriveSecondGenerator(): bigint {
  // Deterministic map into the subgroup; protocols require unknown log_g(h).
  // For demo use, we derive h from domain-separated entropy and expose assumption in UI text.
  const digestInput = new TextEncoder().encode('pedersen-vss-generator-h');
  let acc = 0n;
  for (const b of digestInput) {
    acc = mod(acc * 257n + BigInt(b), Q);
  }
  const seed = mod(acc, Q - 2n) + 2n;
  return modPow(G, seed, P);
}

export const formatBigint = (value: bigint): string => value.toString();

export const evalPolynomial = (coefficients: bigint[], x: bigint, modulus: bigint): bigint => {
  let acc = 0n;
  let power = 1n;
  for (const c of coefficients) {
    acc = mod(acc + c * power, modulus);
    power = mod(power * x, modulus);
  }
  return acc;
};

export const buildRandomPolynomial = (secret: bigint, threshold: number, deterministicRng?: () => bigint): bigint[] => {
  const coefficients: bigint[] = [mod(secret, Q)];
  for (let i = 1; i < threshold; i += 1) {
    coefficients.push(randomBigintBelow(Q, deterministicRng));
  }
  return coefficients;
};

export const buildDeterministicPolynomial = (
  secret: bigint,
  threshold: number,
  label: string,
  seed = 'vss-gate-demo-seed'
): bigint[] => {
  const coefficients: bigint[] = [mod(secret, Q)];
  for (let i = 1; i < threshold; i += 1) {
    coefficients.push(deriveDeterministicScalar(seed, label, secret, i));
  }
  return coefficients;
};

const sharesFromPolynomial = (coefficients: bigint[], participants: number): Share[] => {
  const shares: Share[] = [];
  for (let i = 1; i <= participants; i += 1) {
    shares.push({ participant: i, value: evalPolynomial(coefficients, BigInt(i), Q) });
  }
  return shares;
};

export const runFeldmanWithPolynomial = (
  coefficients: bigint[],
  participants: number,
  cheatParticipant: number | null
): FeldmanRun => {
  const commitments = feldmanCommitments(coefficients);
  const shares = sharesFromPolynomial(coefficients, participants);

  if (cheatParticipant !== null) {
    const idx = cheatParticipant - 1;
    shares[idx] = { participant: cheatParticipant, value: mod(shares[idx].value + 1n, Q) };
  }

  const verification = shares.map((s) => {
    const out = verifyFeldmanShare(s, commitments);
    return { participant: s.participant, lhs: out.lhs, rhs: out.rhs, ok: out.ok };
  });

  return {
    secret: mod(coefficients[0], Q),
    threshold: coefficients.length,
    participants,
    coefficients,
    commitments,
    shares,
    verification,
    cheatedParticipant: cheatParticipant
  };
};

export const feldmanCommitments = (coefficients: bigint[]): bigint[] =>
  coefficients.map((c) => modPow(G, c, P));

const pedersenCommitments = (f: bigint[], r: bigint[]): bigint[] =>
  f.map((coef, i) => mod(modPow(G, coef, P) * modPow(H, r[i], P), P));

export const verifyFeldmanShare = (share: Share, commitments: bigint[]): { lhs: bigint; rhs: bigint; ok: boolean } => {
  const i = BigInt(share.participant);
  const lhs = modPow(G, share.value, P);
  let rhs = 1n;
  let power = 1n;
  for (const commitment of commitments) {
    rhs = mod(rhs * modPow(commitment, power, P), P);
    power = mod(power * i, Q);
  }
  return { lhs, rhs, ok: lhs === rhs };
};

const verifyPedersenShare = (share: PedersenShare, commitments: bigint[]): { lhs: bigint; rhs: bigint; ok: boolean } => {
  const i = BigInt(share.participant);
  const lhs = mod(modPow(G, share.s, P) * modPow(H, share.r, P), P);
  let rhs = 1n;
  let power = 1n;
  for (const commitment of commitments) {
    rhs = mod(rhs * modPow(commitment, power, P), P);
    power = mod(power * i, Q);
  }
  return { lhs, rhs, ok: lhs === rhs };
};

export const lagrangeAtZero = (shares: Share[]): bigint => {
  let secret = 0n;
  for (let i = 0; i < shares.length; i += 1) {
    const xi = BigInt(shares[i].participant);
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < shares.length; j += 1) {
      if (i === j) {
        continue;
      }
      const xj = BigInt(shares[j].participant);
      num = mod(num * (-xj), Q);
      den = mod(den * (xi - xj), Q);
    }
    const inv = modPow(den, Q - 2n, Q);
    secret = mod(secret + shares[i].value * num * inv, Q);
  }
  return secret;
};

export const runFeldman = (
  secret: bigint,
  threshold: number,
  participants: number,
  cheatParticipant: number | null,
  options?: RunOptions
): FeldmanRun => {
  const coefficients = resolvePolynomial(secret, threshold, 'feldman-f', options);
  return runFeldmanWithPolynomial(coefficients, participants, cheatParticipant);
};

export const runPedersen = (
  secret: bigint,
  threshold: number,
  participants: number,
  cheatParticipant: number | null,
  basePolynomial?: bigint[],
  options?: RunOptions
): PedersenRun => {
  const run = normalizeRunOptions(options);
  const fCoefficients = basePolynomial ?? resolvePolynomial(secret, threshold, 'pedersen-f', options);
  const rCoefficients = Array.from({ length: threshold }, (_, i) => {
    if (run.deterministic) {
      return deriveDeterministicScalar(run.seed, 'pedersen-r', secret, i + 1);
    }
    return randomBigintBelow(Q);
  });
  const commitments = pedersenCommitments(fCoefficients, rCoefficients);

  const shares: PedersenShare[] = [];
  for (let i = 1; i <= participants; i += 1) {
    const x = BigInt(i);
    shares.push({
      participant: i,
      s: evalPolynomial(fCoefficients, x, Q),
      r: evalPolynomial(rCoefficients, x, Q)
    });
  }

  if (cheatParticipant !== null) {
    const idx = cheatParticipant - 1;
    shares[idx] = { participant: cheatParticipant, s: mod(shares[idx].s + 1n, Q), r: shares[idx].r };
  }

  const verification = shares.map((s) => {
    const out = verifyPedersenShare(s, commitments);
    return { participant: s.participant, lhs: out.lhs, rhs: out.rhs, ok: out.ok };
  });

  return {
    secret: mod(secret, Q),
    threshold,
    participants,
    fCoefficients,
    rCoefficients,
    commitments,
    shares,
    verification,
    cheatedParticipant: cheatParticipant
  };
};

export const shamirDemo = (secret: bigint, cheatedParticipant: number | null): {
  coefficients: bigint[];
  shares: Share[];
  reconstructed: bigint;
  subset: Share[];
} => {
  const coefficients = buildRandomPolynomial(secret, 2);
  const shares = sharesFromPolynomial(coefficients, 4);
  if (cheatedParticipant !== null) {
    const idx = cheatedParticipant - 1;
    shares[idx] = { participant: cheatedParticipant, value: mod(shares[idx].value + 1n, Q) };
  }

  const subset = cheatedParticipant !== null
    ? [shares[cheatedParticipant - 1], shares[0].participant === cheatedParticipant ? shares[1] : shares[0]]
    : [shares[0], shares[1]];

  return {
    coefficients,
    shares,
    reconstructed: lagrangeAtZero(subset),
    subset
  };
};

export const shamirDemoWithOptions = (
  secret: bigint,
  cheatedParticipant: number | null,
  options?: RunOptions
): {
  coefficients: bigint[];
  shares: Share[];
  reconstructed: bigint;
  subset: Share[];
} => {
  const run = normalizeRunOptions(options);
  const coefficients = run.deterministic
    ? buildDeterministicPolynomial(secret, 2, 'shamir-demo', run.seed)
    : buildRandomPolynomial(secret, 2);
  const shares = sharesFromPolynomial(coefficients, 4);

  if (cheatedParticipant !== null) {
    const idx = cheatedParticipant - 1;
    shares[idx] = { participant: cheatedParticipant, value: mod(shares[idx].value + 1n, Q) };
  }

  const subset = cheatedParticipant !== null
    ? [shares[cheatedParticipant - 1], shares[0].participant === cheatedParticipant ? shares[1] : shares[0]]
    : [shares[0], shares[1]];

  return {
    coefficients,
    shares,
    reconstructed: lagrangeAtZero(subset),
    subset
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// READABLE (SMALL-FIELD) ILLUSTRATIVE INSTANCE
//
// The lab's real work runs in the 2048-bit RFC 3526 field above; that is not
// negotiable. But a 2048-bit integer is unreadable, so the *same* Feldman and
// Pedersen equations are also instantiated here over a tiny safe prime so the
// numbers are legible (three/four digits) and the check can be watched digit by
// digit. This is an ILLUSTRATION of the identical algebra — NOT a security
// parameter. Nothing here weakens the production path; the small field is only
// ever used to render the teaching panels, clearly labelled as illustrative.
//
//   SMALL_P = 2039 is a safe prime, SMALL_Q = (p-1)/2 = 1019 is prime.
//   SMALL_G = 4 = 2^2 generates the order-q subgroup (same construction as G).
//   SMALL_H = g^SMALL_H_EXP lies in the subgroup. Because this is an
//   illustration we KNOW SMALL_H_EXP = log_g(h); in production h must be chosen
//   so nobody knows it — that unknown log is exactly what gives Pedersen its
//   binding. Knowing it here is what lets the equivocation demo compute
//   alternate openings (see pedersenAlternateOpenings), turning "the commitment
//   hides the secret" from a claim into something you can verify.
// ─────────────────────────────────────────────────────────────────────────────

export const SMALL_P = 2039n;
export const SMALL_Q = 1019n;
export const SMALL_G = 4n;
export const SMALL_H_EXP = 7n;
export const SMALL_H = modPow(SMALL_G, SMALL_H_EXP, SMALL_P);

// Map an arbitrary secret into a small, readable value in [2, SMALL_Q).
export const toSmallSecret = (secret: bigint): bigint => mod(secret, 97n) + 2n;

// One term of the RHS product: (commitment C_j) raised to (index i)^j, plus the
// running partial product after multiplying it in. Lets the UI render the
// verification as a growing chain instead of one opaque number.
export type RhsTerm = {
  j: number;
  commitment: bigint;
  exponent: bigint; // i^j mod q
  factor: bigint; // C_j ^ (i^j) mod p
  partial: bigint; // running product mod p
};

export type FeldmanSmallTrace = {
  p: bigint;
  q: bigint;
  g: bigint;
  index: number;
  coefficients: bigint[];
  commitments: bigint[];
  shareValue: bigint; // y_i actually held (already tampered if applicable)
  honestValue: bigint; // f(i) the share *should* be
  tampered: boolean;
  lhs: bigint; // g^(y_i)
  rhsTerms: RhsTerm[];
  rhs: bigint; // ∏ C_j^(i^j)
  ok: boolean;
};

// Build a full, legible Feldman verification trace for ONE participant in the
// small field: LHS = g^y, RHS decomposed term by term. Mirrors
// verifyFeldmanShare exactly, just instrumented and over SMALL_P.
export const feldmanSmallTrace = (
  smallSecret: bigint,
  slope: bigint,
  index: number,
  tamper: boolean
): FeldmanSmallTrace => {
  const coefficients = [mod(smallSecret, SMALL_Q), mod(slope, SMALL_Q)];
  const commitments = coefficients.map((c) => modPow(SMALL_G, c, SMALL_P));
  const i = BigInt(index);
  const honestValue = evalPolynomial(coefficients, i, SMALL_Q);
  const shareValue = tamper ? mod(honestValue + 1n, SMALL_Q) : honestValue;

  const lhs = modPow(SMALL_G, shareValue, SMALL_P);

  const rhsTerms: RhsTerm[] = [];
  let rhs = 1n;
  let power = 1n; // i^j mod q
  for (let j = 0; j < commitments.length; j += 1) {
    const factor = modPow(commitments[j], power, SMALL_P);
    rhs = mod(rhs * factor, SMALL_P);
    rhsTerms.push({ j, commitment: commitments[j], exponent: power, factor, partial: rhs });
    power = mod(power * i, SMALL_Q);
  }

  return {
    p: SMALL_P,
    q: SMALL_Q,
    g: SMALL_G,
    index,
    coefficients,
    commitments,
    shareValue,
    honestValue,
    tampered: tamper,
    lhs,
    rhsTerms,
    rhs,
    ok: lhs === rhs
  };
};

// Three-stage homomorphism trace: coefficient a_j → commitment C_j = g^(a_j),
// then the commitments recombined at index i landing exactly on g^(f(i)).
// Shows WHY exponent arithmetic in the commitments mirrors evaluating f.
export type HomomorphismStage = {
  index: number;
  coefficients: bigint[];
  commitments: bigint[];
  fOfI: bigint; // f(i) mod q
  gPowFofI: bigint; // g^(f(i)) mod p — the target
  recombined: bigint; // ∏ C_j^(i^j) — should equal gPowFofI
  terms: RhsTerm[];
  match: boolean;
};

export const feldmanHomomorphism = (
  smallSecret: bigint,
  slope: bigint,
  index: number
): HomomorphismStage => {
  const coefficients = [mod(smallSecret, SMALL_Q), mod(slope, SMALL_Q)];
  const commitments = coefficients.map((c) => modPow(SMALL_G, c, SMALL_P));
  const i = BigInt(index);
  const fOfI = evalPolynomial(coefficients, i, SMALL_Q);
  const gPowFofI = modPow(SMALL_G, fOfI, SMALL_P);

  const terms: RhsTerm[] = [];
  let recombined = 1n;
  let power = 1n;
  for (let j = 0; j < commitments.length; j += 1) {
    const factor = modPow(commitments[j], power, SMALL_P);
    recombined = mod(recombined * factor, SMALL_P);
    terms.push({ j, commitment: commitments[j], exponent: power, factor, partial: recombined });
    power = mod(power * i, SMALL_Q);
  }

  return {
    index,
    coefficients,
    commitments,
    fOfI,
    gPowFofI,
    recombined,
    terms,
    match: recombined === gPowFofI
  };
};

// Pedersen equivocation: given the small-field commitment C_0 = g^s · h^r to a
// secret, compute a valid alternate opening (s', r') for EACH candidate secret
// such that g^(s') · h^(r') == C_0 exactly. Possible because in this illustration
// we know SMALL_H_EXP = log_g(h): r' = r + (s − s')·(log_g h)^(−1) (mod q). Every
// row produces the identical commitment, so the commitment reveals nothing about
// which secret is real — information-theoretic hiding, demonstrated.
export type PedersenOpening = {
  secret: bigint;
  randomness: bigint;
  commitment: bigint; // g^secret · h^randomness mod p — identical across rows
  isReal: boolean;
};

export const pedersenAlternateOpenings = (
  realSecret: bigint,
  realRandomness: bigint,
  candidateSecrets: bigint[]
): { commitment: bigint; openings: PedersenOpening[] } => {
  const s = mod(realSecret, SMALL_Q);
  const r = mod(realRandomness, SMALL_Q);
  const commitment = mod(modPow(SMALL_G, s, SMALL_P) * modPow(SMALL_H, r, SMALL_P), SMALL_P);
  const hInv = modPow(SMALL_H_EXP, SMALL_Q - 2n, SMALL_Q); // (log_g h)^(-1) mod q

  const openings: PedersenOpening[] = candidateSecrets.map((cand) => {
    const sp = mod(cand, SMALL_Q);
    const rp = mod(r + (s - sp) * hInv, SMALL_Q);
    return {
      secret: sp,
      randomness: rp,
      commitment: mod(modPow(SMALL_G, sp, SMALL_P) * modPow(SMALL_H, rp, SMALL_P), SMALL_P),
      isReal: sp === s
    };
  });

  return { commitment, openings };
};
