/**
 * Exhibit 5 — the dealer who lies. A reshare only preserves the secret if the
 * update polynomials really have zero constant terms; Feldman commitments make
 * that publicly checkable. The learner makes party C cheat, watches the
 * commitment check fail, and (separately) watches what the world would look
 * like if nobody checked — the forged-but-accepted path, rendered as ALARM.
 */
import {
  PARTY_LABELS,
  applyReshare,
  dealZeroUpdate,
  matchesPublicKey,
  publicKey,
  reconstruct,
  verifyDealing,
} from '../reshare/reshare';
import { Q, mod } from '../reuse/vss';
import { chip, el, fullHex, hexRow, paint, truncHex } from './dom';
import { latest, type Session } from './state';

const CHEAT_CONSTANT = 7n;
const CHEATER = 2; // party C

export function cheatPanel(session: Session): HTMLElement {
  const toggle = el('input', { type: 'checkbox', id: 'cheat-toggle' });
  const runBtn = el('button', {
    class: 'btn btn-primary',
    id: 'cheat-run',
    type: 'button',
    text: 'Run one verified reshare round',
  });
  const status = el('p', { class: 'seal-status', role: 'status', 'aria-live': 'polite' });
  const results = el('div', { id: 'cheat-result' });

  runBtn.addEventListener('click', () => {
    void (async () => {
      runBtn.disabled = true;
      const cheating = toggle.checked;
      status.textContent = cheating
        ? 'Party C is dealing δ(0) = 7 instead of 0. Publishing commitments, verifying all five dealings…'
        : 'All five parties dealing honestly. Publishing commitments, verifying all five dealings…';
      await paint();
      try {
        const state = latest(session); // scratch run — nothing here is pushed back
        const dealings = [];
        for (let i = 0; i < state.n; i++) {
          dealings.push(
            await dealZeroUpdate(i, state.t, state.n, i === CHEATER && cheating ? { cheatConstant: CHEAT_CONSTANT } : {}),
          );
        }
        const verdicts = dealings.map((d) => verifyDealing(d, state.n));

        const checkTable = el('div', { class: 'tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Dealing verification results' }, [
          el('table', { class: 'data-table' }, [
            el('caption', { class: 'sr-only', text: 'Verification of each dealer’s update polynomial' }),
            el('thead', {}, [
              el('tr', {}, [
                el('th', { scope: 'col', text: 'Dealer' }),
                el('th', { scope: 'col', text: 'D₀ = g^(δ(0)) as published' }),
                el('th', { scope: 'col', text: 'Zero check: D₀ = 1?' }),
                el('th', { scope: 'col', text: 'Sub-share Feldman checks' }),
              ]),
            ]),
            el('tbody', {}, dealings.map((d, i) =>
              el('tr', { class: verdicts[i].ok ? '' : 'row-alarm' }, [
                el('th', { scope: 'row', text: PARTY_LABELS[d.dealer] }),
                el('td', {}, [el('code', { text: d.commitments[0] === 1n ? '1 (identity)' : truncHex(d.commitments[0]) })]),
                el('td', { text: verdicts[i].zeroCommitmentOk ? '✓ pass' : '✗ FAIL — nonzero constant term' }),
                el('td', {
                  text: `${verdicts[i].subShareOk.filter(Boolean).length}/${state.n} ✓`,
                }),
              ]),
            )),
          ]),
        ]);

        const blocks: HTMLElement[] = [checkTable];

        if (cheating) {
          blocks.push(
            el('p', {
              class: 'note',
              text:
                'Look closely at C’s row: the sub-share checks all PASS. C’s points honestly lie on the polynomial C committed to — the lie lives entirely in the constant term, and only the D₀ = 1 check sees it. That check needs no secrets: everyone computes g⁰ = 1 and compares.',
            }),
          );

          // The protocol path: fail closed, drop the cheater, finish the round.
          const honest = dealings.filter((_, i) => verdicts[i].ok);
          const next = applyReshare(state, honest);
          const rec = reconstruct([0, 1, 2].map((j) => ({ x: BigInt(j + 1), y: next.shares[j] })));

          blocks.push(
            el('div', { class: 'verdict-pair' }, [
              el('div', { class: 'chip-slot' }, [
                el('h4', { text: 'Cryptographic result' }),
                chip('neutral', '✗', `Dealer C’s commitment check FAILED: D₀ = g^${CHEAT_CONSTANT} ≠ 1`),
              ]),
              el('div', { class: 'chip-slot' }, [
                el('h4', { text: 'Security verdict' }),
                chip('ok', '✓', 'HELD — C’s dealing was rejected before it touched a single share'),
              ]),
            ]),
            el('p', { class: 'note' }, [
              `The round completed with the ${honest.length} honest dealings. Audit: reconstructing from the new shares gives back the original secret (g^v = Y: ${matchesPublicKey(rec, publicKey(state)) ? 'MATCH ✓' : 'no match ✗'}), and the public key did not move (${publicKey(next) === publicKey(state) ? 'byte-identical ✓' : 'MOVED ✗'}).`,
            ]),
          );

          // Compute-both-sides: the forged-but-accepted world.
          const forced = applyReshare(state, dealings, { forceUnverified: true });
          const recForced = reconstruct([0, 1, 2].map((j) => ({ x: BigInt(j + 1), y: forced.shares[j] })));
          const shift = mod(recForced - session.secret, Q);

          blocks.push(
            el('details', { class: 'expert', open: '' }, [
              el('summary', { text: 'And if nobody checked? (computed, not asserted)' }),
              hexRow('The secret the committee has been protecting:', fullHex(session.secret)),
              hexRow('What the new shares would reconstruct to:', fullHex(recForced)),
              el('p', { class: 'note' }, [
                'Difference: exactly +',
                el('code', { text: shift.toString() }),
                ` — precisely the constant C smuggled in. The public key would silently become Y·g^${CHEAT_CONSTANT} = `,
                el('code', { text: truncHex(publicKey(forced)) }),
                ', so every verifier in the outside world still pointing at Y would stop accepting this committee.',
              ]),
              chip('alarm', '✗', 'SILENT SECRET CHANGE — a forged dealing, accepted: the shares are consistent, the reconstruction “works”, and the committee no longer holds the key it thinks it holds'),
              el('p', {
                class: 'honesty',
                text:
                  'Scope of this attack, exactly: a nonzero constant term shifts the secret by a known offset. It does not reveal the secret to anyone — this is sabotage (the old key becomes unusable by its own committee), not theft. Theft is panel 3’s game.',
              }),
            ]),
          );
        } else {
          blocks.push(
            el('div', { class: 'verdict-pair' }, [
              el('div', { class: 'chip-slot' }, [
                el('h4', { text: 'Cryptographic result' }),
                chip('neutral', '✓', 'All five dealings verified: D₀ = 1 and every sub-share on its committed polynomial'),
              ]),
              el('div', { class: 'chip-slot' }, [
                el('h4', { text: 'Security verdict' }),
                chip('ok', '✓', 'HELD — an honest round; tick the box above to see what verification is for'),
              ]),
            ]),
          );
        }

        results.replaceChildren(...blocks);
        status.textContent = cheating
          ? 'Verification caught the nonzero constant term. Details below — including the counterfactual where nobody checked.'
          : 'All dealings verified clean.';
      } finally {
        runBtn.disabled = false;
      }
    })();
  });

  return el('section', { class: 'panel', 'aria-labelledby': 'cheat-h' }, [
    el('h2', { id: 'cheat-h', text: '5 · The dealer who lies — Feldman catches a nonzero constant' }),
    el('p', { class: 'panel-lede' }, [
      'Resharing means accepting polynomial updates from other people. A malicious party could deal δ(0) = 7 instead of 0 and ',
      el('em', { text: 'silently change the secret' }),
      ' — every sub-share would look perfectly ordinary. The defense: each dealer must publish Feldman commitments to their polynomial, and commitment number zero must be g⁰ = 1. This runs on the committee from panel 1 (as a scratch round — its real history is untouched).',
    ]),
    el('div', { class: 'controls' }, [
      el('span', { class: 'mode-opt' }, [
        toggle,
        el('label', { for: 'cheat-toggle', text: `Party C cheats: deals δ(0) = ${CHEAT_CONSTANT} instead of 0` }),
      ]),
      runBtn,
    ]),
    status,
    results,
  ]);
}
