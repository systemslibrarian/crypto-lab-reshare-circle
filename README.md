# Reshare Circle — crypto-lab

[![GitHub Pages](https://img.shields.io/badge/demo-live-brightgreen)](https://systemslibrarian.github.io/crypto-lab-reshare-circle/)

> Threshold shares refreshed into a new epoch — the public key unchanged, the secret never reconstructed, and every old share now worthless.

## What It Is

An interactive browser demo of **proactive secret sharing** — the HJKY share-refresh protocol (Herzberg, Jarecki, Krawczyk, Yung, *"Proactive Secret Sharing, or: How to Cope with Perpetual Leakage"*, CRYPTO 1995) plus share redistribution to a new committee.

The problem it teaches: a *t*-of-*n* threshold scheme defends a moment in time, but keys live for years. A **mobile adversary** doesn't need *t* break-ins at once — one custodian this year, another next year, and the quorum is quietly theirs. Proactive resharing resets that clock: on a schedule, every party deals a random polynomial with **zero constant term**, sub-shares are exchanged and Feldman-verified, and each party adds what it received to its share. Every share changes; the secret f(0) — and its public key Y = g^s — provably cannot.

The primitives are real and **consumed from sibling labs, not reimplemented**:

- **Shamir secret sharing over Z_q** — polynomial evaluation, Lagrange interpolation, rejection-sampled randomness — copied verbatim from [crypto-lab-shamir-gate](https://github.com/systemslibrarian/crypto-lab-shamir-gate) (`src/reuse/shamir-math.ts`).
- **RFC 3526 group 14** (2048-bit safe prime, order-q subgroup, g = 4) and **Feldman VSS commitments/verification** — copied verbatim from [crypto-lab-vss-gate](https://github.com/systemslibrarian/crypto-lab-vss-gate) (`src/reuse/vss.ts`, with `export` added to three originally-private helpers).
- The **HJKY resharing layer** on top (`src/reshare/reshare.ts`) is this lab's own hand-rolled, inspectable teaching code.

**What's real vs simulated:** all field and group arithmetic, all dealings, all Feldman checks, and all reconstructions run genuinely in your browser (BigInt, `crypto.getRandomValues`). What's simulated is the *world around* the committee: all five parties live in one browser tab, so private channels, broadcast, epoch clocks and erasure are trivially honest. Panel 2's step-through additionally runs the identical equations over a small labelled field, GF(1019), purely so the numbers fit on screen.

**What it does NOT prove:** that proactive resharing survives a real network (no asynchrony, no Byzantine agreement, no complaint rounds are modeled); that erasure happens (the guarantee collapses if old shares aren't destroyed); or that a breach reaching *t* shares *within one epoch* can be undone — it can't. Feldman commitments reveal g^(a_k), so share secrecy here is computational (discrete log), not information-theoretic.

**Not production crypto — a teaching demo.** Key material is generated per visit and lives only in tab memory.

## Exhibits

1. **Turn the epoch** — the headline. One click runs a full verified HJKY refresh in the real 2048-bit group: 5 zero-commitment checks (D₀ = 1), 25 Feldman sub-share checks, then a side-by-side proof that every share changed while the reconstructed secret is byte-identical and the public key never moved. The full dealing matrix is one `<details>` away.
2. **The whole trick** — a 4-step animated walkthrough of *why* a polynomial pinned to zero at x = 0 changes every share and no secret, over the labelled small field GF(1019) (2-of-3, re-rollable numbers). An honest plot draws the share points, the update polynomial visibly pinned to the origin, every point's +Δ(x) jump with x = 0 unmoved, and finally the mixed-epoch chord landing on deterministic garbage; the table beside it carries the same numbers.
3. **The mobile adversary** — plan the theft campaign yourself in a custodian × epoch grid (default: A@1, B@3, C@5), then run five epochs with and without resharing. Without: the loot interpolates to the private scalar and **g^v = Y says MATCH — rendered as BREACH**, because the verdict and the math are separate indicators. With: the same thefts interpolate to noise. The attacker plays its best subset — so putting all three thefts inside one epoch defeats resharing, and the demo says so honestly instead of pretending otherwise.
4. **Break it yourself** — a checkbox grid of every share from every epoch this page has produced. Pick any three, hit reconstruct: real Lagrange, real public-key check, no guard rails. Mixed epochs give REJECT with no alarm needed; a same-epoch quorum recovers by design; duplicate custodians fail closed with the division-by-zero explanation.
5. **The dealer who lies** — make party C deal δ(0) = 7 instead of 0. Its sub-shares all pass the Feldman check (they honestly match the committed polynomial!) and only the D₀ = 1 check catches the lie. The "if nobody checked" counterfactual is computed, not asserted: the secret shifts by exactly +7 and the public key silently becomes Y·g⁷ — the forged-but-accepted ALARM state.
6. **Rotate the committee** — redistribute 3-of-5 into 4-of-7: a quorum of three old custodians deal their *shares* (never the secret) into fresh degree-3 polynomials; the new seven verify each D₀ against the old public commitments and combine with public Lagrange weights. Same secret, same Y, new people, new threshold.

## When to Use It

- **Use proactive resharing** when a threshold secret must outlive the assumption that any fixed set of share-holders stays honest and uncompromised — long-lived custody keys, root CAs, foundation cold keys, validator withdrawal keys.
- **Use redistribution** when operators join, leave, or the threshold itself must change without a key ceremony that reassembles the secret.
- **Do NOT use this code** for real custody: it is a single-tab teaching demo with no network, no erasure enforcement, no Byzantine fault handling, and no side-channel hardening. Use audited MPC/threshold libraries and their operational playbooks.
- Do NOT reach for resharing to fix a breach that already collected *t* same-epoch shares — nothing can; the key is gone. Resharing is prevention, not revocation.

## Live Demo

**[systemslibrarian.github.io/crypto-lab-reshare-circle](https://systemslibrarian.github.io/crypto-lab-reshare-circle/)**

Advance epochs and watch the compare table; run the mobile adversary both ways; mix epochs in the break-it grid; make a dealer cheat and watch the commitment check catch it; rotate the committee to 4-of-7.

## What Can Go Wrong

- **No resharing at all** — the mobile adversary's slow collection stays valid forever; three thefts years apart equal one clean quorum (exhibit 3).
- **Old shares not erased** — the epoch turn is cosmetic: the attacker's epoch-1 loot still lies on the epoch-1 polynomial, and enough of it reconstructs.
- **A dealer smuggles a nonzero constant term** — the secret silently shifts and the committee loses its own key (sabotage, not theft). Feldman's D₀ = 1 check exists precisely for this (exhibit 5).
- **A tampered sub-share** — caught receiver-by-receiver by the Feldman check; the demo's tests pin this down per-index.
- **≥ t compromises within a single epoch** — outside the model; no refresh schedule saves you.
- **Trusting the interpolation output** — Lagrange always answers, confidently, even on garbage input. The only honest signal is the separate public-key check (exhibits 3 and 4).

## Real-World Usage

- **MPC custody providers** (e.g. Fireblocks, Coinbase, Zengo-style wallets) run periodic share refresh over their MPC key shares — marketed as "key rotation without changing the address" — which is exactly the property exhibit 1 proves.
- **Operator rotation** in threshold signing committees (staking infrastructure, bridge multisigs, HSM quorums) is share redistribution: new committee, new threshold, same public key (exhibit 6).
- HJKY-style refresh appears as the "proactive" layer in threshold-ECDSA/EdDSA suites and in proactive threshold RSA for long-lived CA keys.

## How to Run Locally

```bash
git clone https://github.com/systemslibrarian/crypto-lab-reshare-circle.git
cd crypto-lab-reshare-circle
npm install
npm run dev        # dev server
npm test           # 33 unit tests incl. KATs (Vitest)
npm run build      # typecheck + production build
npm run test:a11y  # axe-core WCAG 2.1 A/AA gate, both themes (Playwright)
```

## Related Demos

- [shamir-gate](https://systemslibrarian.github.io/crypto-lab-shamir-gate/) — the Shamir math this lab consumes, and the below-threshold "confidently wrong" lesson.
- [vss-gate](https://systemslibrarian.github.io/crypto-lab-vss-gate/) — Feldman and Pedersen commitments, consumed here as the verifier.
- [gg20-wallet](https://systemslibrarian.github.io/crypto-lab-gg20-wallet/) / [threshold-decrypt](https://systemslibrarian.github.io/crypto-lab-threshold-decrypt/) — distributed key generation, the trusted-dealer assumption removed.
- [frost-threshold](https://systemslibrarian.github.io/crypto-lab-frost-threshold/) / [shamir-vs-frost](https://systemslibrarian.github.io/crypto-lab-shamir-vs-frost/) / [threshold-mldsa](https://systemslibrarian.github.io/crypto-lab-threshold-mldsa/) — *using* a shared secret without reconstructing it.

## Build & Verify

- **33 unit tests, all passing** (`npm test`): `src/reuse/reuse.test.ts` (11) pins the consumed modules with KATs — Shamir vectors from shamir-gate's own suite, RFC 3526 group-14 vectors (2048-bit safe prime, Fermat checks, subgroup order) from vss-gate's — and `src/reshare/reshare.test.ts` (22) covers every-subset round-trips, refresh invariants (secret/Y preserved, all shares changed, new shares verify), a fully hand-computed reshare KAT over GF(1019) (shares 47/52/57 → 61/80/99, mixed-epoch garbage exactly 14), exact cheat consequences (+c and Y·g^c), fail-closed duplicate-x and unverified-dealing paths, membership change, and the mobile adversary in all four honesty-critical regimes: cross-epoch thefts with and without resharing, a within-one-epoch quorum that resharing provably cannot stop, best-subset attacker play, and below-threshold futility.
- **Accessibility is gated in CI**: `npm run build && npm run test:a11y` scans the production build with axe-core (WCAG 2.1 A/AA) in both themes after driving every exhibit, and the GitHub Pages deploy is blocked on failure.

## Performance

The demo runs real 2048-bit modular exponentiation in BigInt: a fully verified epoch turn is ~35 group exponentiations plus 25 verification checks and takes a few seconds on commodity hardware. That cost is the honest price of "no simulated math" and is narrated in the UI status lines.

---

*One of 120+ browser demos in the [Crypto Lab](https://crypto-lab.systemslibrarian.dev/) suite.*

*"So whether you eat or drink or whatever you do, do it all for the glory of God." — 1 Corinthians 10:31*
