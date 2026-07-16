/**
 * Exhibit 2 — the mechanism, made legible AND visible. The identical algebra
 * as exhibit 1, instantiated over the labelled small field GF(1019) (consumed
 * from vss-gate's illustrative instance) so every number fits on screen.
 *
 * The plot draws the honest discrete objects: the share POINTS. The faint
 * dashed lines are guides for the eye only — legitimate here because the
 * miniature's values are kept below q, so nothing wraps and the polynomials
 * really do look like lines on this window (the note says so out loud).
 * Motion is tied to the step buttons; prefers-reduced-motion disables it.
 */
import { randomBigInt } from '../reuse/shamir-math';
import { SMALL_Q, evalPolynomial, mod } from '../reuse/vss';
import { reconstruct } from '../reshare/reshare';
import { el } from './dom';

const XS = [1n, 2n, 3n];
const NAMES = ['A', 'B', 'C'];
const SVG_NS = 'http://www.w3.org/2000/svg';

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
  'The refresh: each custodian deals a random polynomial that is FORCED through zero at x = 0 — it has no constant term. Their sum Δ (gold in the plot) is pinned to the origin, and everyone can verify that without seeing any polynomial, because each dealer’s first Feldman commitment must be g⁰ = 1.',
  'Each custodian adds what it received: every share point jumps by +Δ(x). The point at x = 0 would jump by Δ(0) = 0 — it cannot move. New shares, same secret, and nobody computed anything at x = 0 to make that happen.',
  'The proof by interpolation: two epoch-2 shares still meet at the secret. Two epoch-1 shares still did. But take one share from each epoch and the line through them (red) lands somewhere meaningless — two points from two different polynomials. That is the whole security story of panel 3.',
];

export function mechanismPanel(): HTMLElement {
  let mini: Mini = DEFAULT;
  let step = 0;

  const table = el('div', {});
  const plotWrap = el('div', { class: 'mech-plot' });
  const caption = el('p', { class: 'mech-caption', role: 'status', 'aria-live': 'polite' });
  const prevBtn = el('button', { class: 'btn', id: 'mech-prev', type: 'button', text: '← Back' });
  const nextBtn = el('button', { class: 'btn btn-primary', id: 'mech-next', type: 'button', text: 'Next step →' });
  const rerollBtn = el('button', { class: 'btn', id: 'mech-reroll', type: 'button', text: 'Re-roll the numbers' });

  const fAt = (x: bigint) => evalPolynomial(mini.f, x, SMALL_Q);
  const dAt = (d: number, x: bigint) => evalPolynomial(mini.deltas[d], x, SMALL_Q);
  const newShare = (x: bigint) =>
    mod(fAt(x) + dAt(0, x) + dAt(1, x) + dAt(2, x), SMALL_Q);

  let stepGroups: SVGGElement[] = [];

  function sv<K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string> = {},
    children: Array<SVGElement | string> = [],
  ): SVGElementTagNameMap[K] {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const c of children) node.append(c);
    return node;
  }
  const svText = (x: number, y: number, text: string, attrs: Record<string, string> = {}) =>
    sv('text', { x: String(x), y: String(y), 'font-size': '12', fill: 'var(--text)', ...attrs }, [text]);

  /**
   * Build the plot once per instance; steps only fade groups in/out so the
   * reveal is a transition, not a rebuild.
   */
  function buildPlot(): void {
    const f0 = Number(mini.f[0]);
    const fV = [0, 1, 2, 3].map((x) => Number(fAt(BigInt(x))));
    const dV = [0, 1, 2, 3].map((x) =>
      Number(mod(dAt(0, BigInt(x)) + dAt(1, BigInt(x)) + dAt(2, BigInt(x)), SMALL_Q)),
    );
    const f2V = [0, 1, 2, 3].map((x) => Number(newShare(BigInt(x))));
    const mixed = 2 * fV[1] - f2V[2]; // kept nonnegative by the re-roll ranges

    const yMax = Math.max(f2V[3], fV[3]) * 1.14;
    const X = (x: number) => 70 + x * 118;
    const Y = (v: number) => 288 - (v / yMax) * 260;
    const chord = (x: number) => fV[1] + (f2V[2] - fV[1]) * (x - 1);

    const circle = (x: number, v: number, fill: string) =>
      sv('circle', { cx: String(X(x)), cy: String(Y(v)), r: '5', fill });
    const square = (x: number, v: number, fill: string) =>
      sv('rect', { x: String(X(x) - 4.5), y: String(Y(v) - 4.5), width: '9', height: '9', fill });
    const diamond = (x: number, v: number, fill: string) =>
      sv('rect', {
        x: String(X(x) - 4.5),
        y: String(Y(v) - 4.5),
        width: '9',
        height: '9',
        fill,
        transform: `rotate(45 ${X(x)} ${Y(v)})`,
      });
    const guide = (vals: number[], stroke: string) =>
      sv('polyline', {
        points: vals.map((v, x) => `${X(x)},${Y(v)}`).join(' '),
        fill: 'none',
        stroke,
        'stroke-width': '1.5',
        'stroke-dasharray': '4 3',
        'stroke-opacity': '0.65',
      });
    const ring = (x: number, v: number, stroke: string) =>
      sv('circle', { cx: String(X(x)), cy: String(Y(v)), r: '10', fill: 'none', stroke, 'stroke-width': '2' });

    // Base: axes, the secret's seat, epoch-1 points.
    const base = sv('g', {}, [
      sv('line', { x1: '58', y1: '288', x2: '525', y2: '288', stroke: 'var(--text-dim)', 'stroke-width': '1' }),
      sv('line', { x1: '58', y1: '14', x2: '58', y2: '288', stroke: 'var(--text-dim)', 'stroke-width': '1' }),
      svText(X(0) - 4, 305, '0', { fill: 'var(--text-dim)' }),
      ...[1, 2, 3].map((x) => svText(X(x) - 18, 305, `${NAMES[x - 1]} · x=${x}`, { fill: 'var(--text-dim)' })),
      sv('line', {
        x1: String(X(0)), y1: '14', x2: String(X(0)), y2: '288',
        stroke: 'var(--accent-text)', 'stroke-width': '1.5', 'stroke-dasharray': '5 4',
      }),
      svText(X(0) + 6, 26, 'the secret’s seat — no share lives here', { fill: 'var(--accent-text)' }),
      guide(fV, 'var(--accent-text)'),
      ...[0, 1, 2, 3].map((x) => circle(x, fV[x], 'var(--accent-text)')),
      ...[1, 2, 3].map((x) => svText(X(x) - 26, Y(fV[x]) + 4, String(fV[x]))),
      svText(X(0) + 8, Y(f0) - 8, `secret = ${f0}`),
      svText(X(3) + 14, Y(fV[3]) + 4, 'epoch 1', { fill: 'var(--accent-text)' }),
    ]);

    // Step 1: the summed update polynomial, pinned at the origin.
    const g1 = sv('g', { 'data-step': '1' }, [
      guide(dV, 'var(--mark-line)'),
      ...[0, 1, 2, 3].map((x) => diamond(x, dV[x], 'var(--mark-line)')),
      ...[1, 2, 3].map((x) => svText(X(x) + 8, Y(dV[x]) + 14, String(dV[x]))),
      ring(0, 0, 'var(--mark-line)'),
      svText(X(0) + 16, 280, 'Δ pinned to 0', { fill: 'var(--text)' }),
      svText(X(3) + 14, Y(dV[3]) + 4, 'update Δ', { fill: 'var(--text)' }),
    ]);

    // Step 2: epoch-2 points plus the jump arrows; x = 0 provably unmoved.
    const arrow = (x: number) => {
      const yFrom = Y(fV[x]);
      const yTo = Y(f2V[x]) + 9;
      return sv('g', {}, [
        sv('line', {
          x1: String(X(x)), y1: String(yFrom - 7), x2: String(X(x)), y2: String(yTo + 4),
          stroke: 'var(--mark-line)', 'stroke-width': '1.5',
        }),
        sv('polygon', {
          points: `${X(x) - 4},${yTo + 6} ${X(x) + 4},${yTo + 6} ${X(x)},${yTo - 2}`,
          fill: 'var(--mark-line)',
        }),
        svText(X(x) + 8, (yFrom + yTo) / 2 + 4, `+${dV[x]}`),
      ]);
    };
    const g2 = sv('g', { 'data-step': '2' }, [
      guide(f2V, 'var(--ok-text)'),
      ...arrowless(f2V, square),
      ...[1, 2, 3].map(arrow),
      ...[1, 2, 3].map((x) => svText(X(x) + 8, Y(f2V[x]) - 8, String(f2V[x]))),
      svText(X(0) + 8, Y(f0) + 20, 'unmoved', { fill: 'var(--ok-text)' }),
      svText(X(3) + 14, Y(f2V[3]) + 4, 'epoch 2', { fill: 'var(--ok-text)' }),
    ]);
    function arrowless(vals: number[], shape: typeof square): SVGElement[] {
      return [0, 1, 2, 3].map((x) => shape(x, vals[x], 'var(--ok-text)'));
    }

    // Step 3: the mixed-epoch chord — one point from each epoch, extended to
    // x = 0, landing on garbage. Honest: two points DO determine this line.
    const g3 = sv('g', { 'data-step': '3' }, [
      sv('line', {
        x1: String(X(0)), y1: String(Y(mixed)), x2: String(X(2.35)), y2: String(Y(chord(2.35))),
        stroke: 'var(--alarm-text)', 'stroke-width': '2', 'stroke-dasharray': '7 4',
      }),
      ring(1, fV[1], 'var(--alarm-text)'),
      ring(2, f2V[2], 'var(--alarm-text)'),
      sv('g', {}, [
        sv('line', {
          x1: String(X(0) - 6), y1: String(Y(mixed) - 6), x2: String(X(0) + 6), y2: String(Y(mixed) + 6),
          stroke: 'var(--alarm-text)', 'stroke-width': '2.5',
        }),
        sv('line', {
          x1: String(X(0) - 6), y1: String(Y(mixed) + 6), x2: String(X(0) + 6), y2: String(Y(mixed) - 6),
          stroke: 'var(--alarm-text)', 'stroke-width': '2.5',
        }),
      ]),
      // Fixed spot under the seat caption — clear of every data-driven label.
      svText(X(0) + 6, 44, `mixed epochs: A₁ + B₂ → ${mixed}, not ${f0}`, { fill: 'var(--alarm-text)' }),
    ]);

    const svg = sv('svg', {
      viewBox: '0 0 560 320',
      role: 'img',
      'aria-label':
        `Plot of the miniature reshare: epoch-1 share points at heights ${fV[1]}, ${fV[2]} and ${fV[3]} each jump by the gold update polynomial — which is pinned to zero at x equals zero — landing on epoch-2 points ${f2V[1]}, ${f2V[2]} and ${f2V[3]}. The value at x equals zero stays ${f0}. A red line through one share from each epoch lands at ${mixed} instead of ${f0}. The same numbers appear in the table below.`,
    }, [base, g1, g2, g3]);
    svg.style.width = '100%';
    svg.style.height = 'auto';

    stepGroups = [g1, g2, g3];
    plotWrap.replaceChildren(svg);
  }

  function render(): void {
    const secret = mini.f[0];

    for (const g of stepGroups) {
      g.style.opacity = step >= Number(g.dataset.step) ? '1' : '0';
    }

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
      // Ranges chosen so every visible value stays below q (nothing wraps —
      // the plot's guides stay honest) and the mixed-epoch intercept
      // f(0) − 2·Σslopes stays positive: slopes ≤ 10 ⇒ 2Σ ≤ 60 < 61 ≤ f(0).
      mini = {
        f: [await randomBigInt(61n, 97n), await randomBigInt(1n, 31n)],
        deltas: [
          [0n, await randomBigInt(1n, 11n)],
          [0n, await randomBigInt(1n, 11n)],
          [0n, await randomBigInt(1n, 11n)],
        ],
      };
      buildPlot();
      render();
    })();
  });

  buildPlot();
  render();

  return el('section', { class: 'panel', 'aria-labelledby': 'mech-h' }, [
    el('h2', { id: 'mech-h', text: '2 · The whole trick — a polynomial pinned to zero' }),
    el('p', {
      class: 'panel-lede',
      text:
        'Why does adding random polynomials change every share but never the secret? Because every update is pinned to zero at x = 0. Step through it — the plot and the table show the same numbers.',
    }),
    el('p', {
      class: 'honesty',
      text:
        'Illustrative miniature: identical equations to panel 1, run over the tiny field GF(1019) (the same labelled teaching field vss-gate uses) with threshold 2-of-3, so the numbers fit on screen. The values are kept small enough that nothing wraps mod q, which is why the dashed guide lines are honest here; in the real field the same algebra holds with wraparound. This panel proves nothing panel 1 hasn’t already done for real in the 2048-bit group.',
    }),
    el('div', { class: 'controls' }, [prevBtn, nextBtn, rerollBtn]),
    caption,
    plotWrap,
    table,
  ]);
}
