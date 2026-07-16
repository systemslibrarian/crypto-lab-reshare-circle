/**
 * Exhibit 2 — the mechanism, made legible. The identical algebra as exhibit 1,
 * instantiated over the labelled small field GF(1019) (consumed from
 * vss-gate's illustrative instance) so every number fits on screen. A
 * step-through, driven only by the learner's clicks — no idle motion.
 */
import { randomBigInt } from '../reuse/shamir-math';
import { SMALL_Q, evalPolynomial, mod } from '../reuse/vss';
import { reconstruct } from '../reshare/reshare';
import { el } from './dom';

const XS = [1n, 2n, 3n];
const NAMES = ['A', 'B', 'C'];

interface Mini {
  f: bigint[]; // [secret, slope] — epoch-1 polynomial
  deltas: bigint[][]; // three zero-constant updates [0, slope]
}

const DEFAULT: Mini = {
  // The exact instance the hand-computed KAT in reshare.test.ts pins down.
  f: [42n, 5n],
  deltas: [
    [0n, 3n],
    [0n, 10n],
    [0n, 1n],
  ],
};

const CAPTIONS = [
  'Epoch 1. Three custodians hold one point each on the line f. Any two points determine the line; its height at x = 0 is the secret. No one holds x = 0.',
  'The refresh: each custodian deals a random polynomial that is FORCED through zero at x = 0 — it has no constant term. Read down the x = 0 column: all zeros, by construction. And everyone can verify that without seeing the polynomial, because the dealer’s first Feldman commitment must be g⁰ = 1.',
  'Each custodian adds the three values it received to its own share. Every share moves — each column added three nonzero numbers. The x = 0 column added 0 + 0 + 0. The shares cannot avoid changing; the secret cannot manage to.',
  'The proof by interpolation: two epoch-2 shares still meet at 42. Two epoch-1 shares still meet at 42. But one share from each epoch lies on two DIFFERENT polynomials — interpolating them lands somewhere meaningless. That is the whole security story of panel 3.',
];

export function mechanismPanel(): HTMLElement {
  let mini: Mini = DEFAULT;
  let step = 0;

  const table = el('div', {});
  const caption = el('p', { class: 'mech-caption', role: 'status', 'aria-live': 'polite' });
  const prevBtn = el('button', { class: 'btn', id: 'mech-prev', type: 'button', text: '← Back' });
  const nextBtn = el('button', { class: 'btn btn-primary', id: 'mech-next', type: 'button', text: 'Next step →' });
  const rerollBtn = el('button', { class: 'btn', id: 'mech-reroll', type: 'button', text: 'Re-roll the numbers' });

  const fAt = (x: bigint) => evalPolynomial(mini.f, x, SMALL_Q);
  const dAt = (d: number, x: bigint) => evalPolynomial(mini.deltas[d], x, SMALL_Q);
  const newShare = (x: bigint) =>
    mod(fAt(x) + dAt(0, x) + dAt(1, x) + dAt(2, x), SMALL_Q);

  function render(): void {
    const secret = mini.f[0];
    const rows: HTMLElement[] = [];

    rows.push(
      el('tr', {}, [
        el('th', { scope: 'row' }, [`epoch-1 shares — f(x) = ${secret} + ${mini.f[1]}·x`]),
        el('td', { class: 'seat-zero', text: String(secret) }),
        ...XS.map((x) => el('td', { text: String(fAt(x)) })),
      ]),
    );

    if (step >= 1) {
      mini.deltas.forEach((d, i) => {
        rows.push(
          el('tr', { class: 'delta-row' }, [
            el('th', { scope: 'row' }, [`${NAMES[i]} deals δ${'₁₂₃'[i]}(x) = ${d[1]}·x  (no constant term)`]),
            el('td', { class: 'seat-zero', text: '0' }),
            ...XS.map((x) => el('td', { text: `+${dAt(i, x)}` })),
          ]),
        );
      });
    }

    if (step >= 2) {
      rows.push(
        el('tr', { class: 'sum-row' }, [
          el('th', { scope: 'row', text: 'epoch-2 shares — each party adds what it received' }),
          el('td', { class: 'seat-zero' }, [`${secret}`, el('span', { 'aria-hidden': 'true', text: ' *' })]),
          ...XS.map((x) => el('td', {}, [el('mark', { text: String(newShare(x)) })])),
        ]),
      );
    }

    const checks: HTMLElement[] = [];
    if (step >= 3) {
      const q = SMALL_Q;
      const rec = (pts: Array<[bigint, bigint]>) =>
        reconstruct(pts.map(([x, y]) => ({ x, y })), q);
      const both2 = rec([[1n, newShare(1n)], [2n, newShare(2n)]]);
      const both1 = rec([[2n, fAt(2n)], [3n, fAt(3n)]]);
      const mixed = rec([[1n, fAt(1n)], [2n, newShare(2n)]]);
      checks.push(
        el('ul', { class: 'scope-list' }, [
          el('li', {}, [
            `A₂ and B₂ (both epoch 2) interpolate to ${both2} — the secret, intact ✓`,
          ]),
          el('li', {}, [
            `B₁ and C₁ (both epoch 1) interpolate to ${both1} — old quorums still worked, until the old shares were erased ✓`,
          ]),
          el('li', {}, [
            `A₁ and B₂ (one from each epoch) interpolate to ${mixed} — not ${secret}, not anything: two points from two different lines ✗`,
          ]),
        ]),
      );
    }

    table.replaceChildren(
      el('div', { class: 'tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Small-field reshare arithmetic' }, [
        el('table', { class: 'data-table mech-table' }, [
          el('caption', { class: 'sr-only', text: 'Reshare arithmetic in the small field GF(1019)' }),
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col' }, [el('span', { class: 'sr-only', text: 'Row' })]),
              el('th', { scope: 'col', class: 'seat-zero' }, ['x = 0 — the secret’s seat (no one holds it)']),
              ...XS.map((x, i) => el('th', { scope: 'col', text: `${NAMES[i]} (x = ${x})` })),
            ]),
          ]),
          el('tbody', {}, rows),
        ]),
      ]),
      ...checks,
      step >= 2
        ? el('p', {
            class: 'note',
            text:
              '* Never computed by any party — this column exists only on this screen, to expose the algebra. In the protocol, x = 0 is exactly the place no message ever touches.',
          })
        : el('span', {}),
    );

    caption.textContent = `Step ${step + 1} of 4 — ${CAPTIONS[step]}`;
    prevBtn.disabled = step === 0;
    nextBtn.disabled = step === CAPTIONS.length - 1;
  }

  prevBtn.addEventListener('click', () => {
    step = Math.max(0, step - 1);
    render();
  });
  nextBtn.addEventListener('click', () => {
    step = Math.min(CAPTIONS.length - 1, step + 1);
    render();
  });
  rerollBtn.addEventListener('click', () => {
    void (async () => {
      // Small ranges keep every visible value under 1019, so no value wraps
      // and the addition can be checked by eye. Same equations regardless.
      mini = {
        f: [await randomBigInt(2n, 97n), await randomBigInt(1n, 50n)],
        deltas: [
          [0n, await randomBigInt(1n, 31n)],
          [0n, await randomBigInt(1n, 31n)],
          [0n, await randomBigInt(1n, 31n)],
        ],
      };
      render();
    })();
  });

  render();

  return el('section', { class: 'panel', 'aria-labelledby': 'mech-h' }, [
    el('h2', { id: 'mech-h', text: '2 · The whole trick — a polynomial pinned to zero' }),
    el('p', {
      class: 'panel-lede',
      text:
        'Why does adding random polynomials change every share but never the secret? Because every update is pinned to zero at x = 0. Step through the arithmetic.',
    }),
    el('p', {
      class: 'honesty',
      text:
        'Illustrative miniature: identical equations to panel 1, run over the tiny field GF(1019) (the same labelled teaching field vss-gate uses) with threshold 2-of-3, so the numbers fit on screen. This panel proves nothing panel 1 hasn’t already done for real in the 2048-bit group.',
    }),
    el('div', { class: 'controls' }, [prevBtn, nextBtn, rerollBtn]),
    caption,
    table,
  ]);
}
