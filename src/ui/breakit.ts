/**
 * Exhibit 4 — break it yourself. Every share from every epoch this page has
 * produced, a checkbox grid, and real Lagrange interpolation in the real
 * group with no guard rails. The learner causes the failure; the verifier
 * (g^v = Y?) is the same check used everywhere else on the page.
 */
import {
  PARTY_LABELS,
  matchesPublicKey,
  publicKey,
  reconstruct,
} from '../reshare/reshare';
import { chip, el, paint, truncHex } from './dom';
import { T, latest, type Session } from './state';

interface Pick {
  party: number;
  epoch: number;
  value: bigint;
}

export function breakitPanel(session: Session): HTMLElement {
  const gridWrap = el('div', {});
  const status = el('p', { class: 'seal-status', role: 'status', 'aria-live': 'polite' });
  const results = el('div', { id: 'breakit-result' });
  const runBtn = el('button', {
    class: 'btn btn-primary',
    id: 'breakit-run',
    type: 'button',
    text: 'Reconstruct from selected shares',
  });

  function renderGrid(): void {
    const epochs = session.epochs;
    const latestEpoch = epochs[epochs.length - 1].epoch;
    // Default selection spreads across epochs when it can: A from epoch 1,
    // B and C from the newest epoch — the exact mistake worth making.
    const defaults = new Set<string>([
      `0:1`,
      `1:${latestEpoch}`,
      `2:${latestEpoch}`,
    ]);

    gridWrap.replaceChildren(
      el('div', { class: 'tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Shares by custodian and epoch' }, [
        el('table', { class: 'data-table' }, [
          el('caption', { class: 'sr-only', text: 'Select shares to feed the reconstructor' }),
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Custodian' }),
              ...epochs.map((e) => el('th', { scope: 'col', text: `Epoch ${e.epoch} · polynomial #${e.epoch}` })),
            ]),
          ]),
          el('tbody', {}, PARTY_LABELS.slice(0, latest(session).n).map((label, j) =>
            el('tr', {}, [
              el('th', { scope: 'row', text: label }),
              ...epochs.map((e) => {
                const id = `pick-${j}-${e.epoch}`;
                const box = el('input', {
                  type: 'checkbox',
                  id,
                  'data-party': String(j),
                  'data-epoch': String(e.epoch),
                  'data-value': e.shares[j].toString(),
                });
                if (defaults.has(`${j}:${e.epoch}`)) box.checked = true;
                return el('td', {}, [
                  el('span', { class: 'pick-cell' }, [
                    box,
                    el('label', { for: id }, [
                      el('span', { class: 'sr-only', text: `${label}, epoch ${e.epoch}: ` }),
                      el('code', { text: truncHex(e.shares[j]) }),
                    ]),
                  ]),
                ]);
              }),
            ]),
          )),
        ]),
      ]),
      session.epochs.length === 1
        ? el('p', {
            class: 'note',
            text:
              'Only one epoch exists so far — advance an epoch in panel 1 and this grid grows a column, which is where mixing becomes possible.',
          })
        : el('span', {}),
    );
    // The grid just re-defaulted to a different selection (panel 1 added an
    // epoch column): any verdict still on screen describes the old ticks.
    retractVerdict();
  }

  /**
   * Retract a standing verdict. Everything this panel prints is a claim about
   * ONE exact selection, so the instant the selection changes, the verdict on
   * screen is about shares that are no longer ticked.
   *
   * That happens two ways, and the second is the one that bit: the learner
   * ticks a box, OR panel 1 turns the epoch and `renderGrid` re-defaults this
   * grid underneath a standing verdict. Reconstructing A@2/B@2/C@2 leaves
   * "g^v = Y — MATCH" + "RECOVERED, BY DESIGN — 3 shares from epoch 2"; the
   * next epoch turn silently re-ticks A@1/B@3/C@3, a mixed-epoch selection
   * that reconstructs to noise — and the MATCH verdict used to keep sitting
   * over it, telling the learner the exact opposite of what those shares do.
   */
  function retractVerdict(): void {
    if (results.childNodes.length === 0) return;
    results.replaceChildren();
    status.textContent =
      'Selection changed — reconstruct again for a verdict about the shares now ticked.';
  }

  function selected(): Pick[] {
    return Array.from(gridWrap.querySelectorAll<HTMLInputElement>('input:checked')).map((box) => ({
      party: Number(box.dataset.party),
      epoch: Number(box.dataset.epoch),
      value: BigInt(box.dataset.value ?? '0'),
    }));
  }

  runBtn.addEventListener('click', () => {
    void (async () => {
      runBtn.disabled = true;
      status.textContent = 'Interpolating the selected shares at x = 0 (real Lagrange over Z_q)…';
      await paint();
      try {
        const picks = selected();
        const y = publicKey(latest(session));

        if (picks.length < 2) {
          results.replaceChildren(
            chip('neutral', '✗', 'Pick at least two shares — one point determines nothing.'),
          );
          status.textContent = 'Nothing to interpolate yet.';
          return;
        }

        const partiesSeen = new Set(picks.map((p) => p.party));
        if (partiesSeen.size !== picks.length) {
          const dup = PARTY_LABELS[picks.find((p) => picks.filter((o) => o.party === p.party).length > 1)!.party];
          results.replaceChildren(
            chip('neutral', '✗', `Interpolation refused before it starts: ${dup} is selected twice.`),
            el('p', {
              class: 'note',
              text:
                `Two shares from the same custodian share an x-coordinate, and Lagrange divides by (xᵢ − xⱼ) — zero here. The math fails closed: this is the one mixture the field itself refuses to evaluate. Pick ${T} distinct custodians instead.`,
            }),
          );
          status.textContent = 'Refused: duplicate x-coordinate.';
          return;
        }

        const v = reconstruct(picks.map((p) => ({ x: BigInt(p.party + 1), y: p.value })));
        const match = matchesPublicKey(v, y);
        const epochsSeen = new Set(picks.map((p) => p.epoch));
        const sameEpoch = epochsSeen.size === 1;

        const facts = el('div', {}, [
          el('p', {}, [
            'Interpolation output: ',
            el('code', { class: 'inline-hex', text: truncHex(v) }),
            ' — a perfectly well-formed element of Z_q. Interpolation always answers; it never knows whether its inputs belonged together.',
          ]),
        ]);

        const cryptoChip = chip(
          'neutral',
          match ? '✓' : '✗',
          match ? 'g^v = Y — MATCH: v is the secret scalar' : 'g^v ≠ Y — NO MATCH: v is not the secret',
        );

        let verdict: HTMLElement;
        let explain: string;
        if (match) {
          // "same-epoch" is read off the picks, not assumed from the match. A
          // quorum drawn from one epoch is the only way this branch is reached
          // in practice, but the panel's whole point is that the verdict must
          // be computed rather than inferred from the crypto result.
          verdict = chip(
            'ok',
            '✓',
            sameEpoch
              ? `RECOVERED, BY DESIGN — ${picks.length} shares from epoch ${[...epochsSeen][0]} meet the ${T}-of-5 threshold`
              : `RECOVERED — and from shares spanning epochs ${[...epochsSeen].sort((a, b) => a - b).join(', ')}, which should be impossible; treat this run as suspect`,
          );
          explain =
            'In your hands this is the scheme working: an authorized quorum from one epoch reconstructs. In the mobile adversary’s hands (panel 3, resharing off), this same math is the breach — which is why the verdict up there is ALARM even though the crypto says MATCH.';
        } else if (!sameEpoch) {
          verdict = chip('ok', '✓', 'REJECT, NO ALARM — mixed-epoch shares are worthless by algebra, not by policy');
          explain =
            `You mixed epochs ${[...epochsSeen].sort((a, b) => a - b).join(' and ')}. Each epoch’s shares lie on a different polynomial; points from different polynomials interpolate to noise. Nothing detected the attack, nothing needed to: the honest failure IS the defense. This is what the attacker’s loot looks like after a reshare.`;
        } else {
          verdict = chip('ok', '✓', `HELD — ${picks.length} shares are below the threshold of ${T}`);
          explain =
            'Below the threshold, interpolation still answers — confidently and wrongly, with no hint it is wrong except the public-key check. Why fewer than t shares reveal literally nothing is shamir-gate’s whole lesson.';
        }

        results.replaceChildren(
          facts,
          el('div', { class: 'verdict-pair' }, [
            el('div', { class: 'chip-slot' }, [el('h4', { text: 'Cryptographic result' }), cryptoChip]),
            el('div', { class: 'chip-slot' }, [el('h4', { text: 'Security verdict' }), verdict]),
          ]),
          el('p', { class: 'breakit-explain note', text: explain }),
        );
        status.textContent = 'Reconstruction finished — result and verdict below.';
      } finally {
        runBtn.disabled = false;
      }
    })();
  });

  // Delegated on the stable wrapper, so it survives every renderGrid rebuild.
  gridWrap.addEventListener('change', retractVerdict);

  session.onChange.add(renderGrid);
  renderGrid();

  return el('section', { class: 'panel', 'aria-labelledby': 'break-h' }, [
    el('h2', { id: 'break-h', text: '4 · Break it yourself — mix the epochs' }),
    el('p', { class: 'panel-lede' }, [
      'This grid is every share from every epoch this page has produced (panel 1 adds columns). Play the attacker: pick any ',
      el('strong', { text: 'three' }),
      ' and reconstruct. Real Lagrange interpolation against the real verifier — no guard rails, no simulated outcomes.',
    ]),
    gridWrap,
    el('div', { class: 'seal-row' }, [runBtn]),
    status,
    results,
  ]);
}
