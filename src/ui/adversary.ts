/**
 * Exhibit 3 — the mobile adversary. The learner picks the theft pattern, then
 * runs the five epochs twice against real crypto: once with a committee that
 * never reshares, once with one that reshares every epoch. The cryptographic
 * result (does g^v equal Y?) and the security verdict are SEPARATE indicators
 * — the point of the lab is the run where the math says MATCH and the verdict
 * screams BREACH. And the honest edge is playable: put all three thefts
 * inside one epoch and resharing does not save you.
 */
import { PARTY_LABELS, runMobileAdversary } from '../reshare/reshare';
import type { AdversaryRun, Steal } from '../reshare/types';
import { chip, el, paint, truncHex } from './dom';

const EPOCHS = 5;
const PARTIES = 5;
const T = 3;
const DEFAULT_STEALS = new Set(['0:1', '1:3', '2:5']); // A@1, B@3, C@5

function stealLabel(s: Steal): string {
  return `${PARTY_LABELS[s.party]}@${s.epoch}`;
}

function renderRun(run: AdversaryRun): HTMLElement[] {
  const timeline = el('ol', { class: 'timeline' }, []);
  for (let e = 1; e <= EPOCHS; e++) {
    const items: Array<Node | string> = [el('strong', { text: `Epoch ${e}` })];
    const thefts = run.steals.filter((s) => s.epoch === e);
    if (thefts.length > 0) {
      items.push(
        el('span', { class: 'steal-note' }, [
          ` — attacker copies ${thefts.map((s) => `${PARTY_LABELS[s.party]}’s`).join(' and ')} current share${thefts.length > 1 ? 's' : ''}`,
        ]),
      );
    }
    if (e < EPOCHS) {
      items.push(
        el('span', { class: 'epoch-note' }, [
          run.reshareOn
            ? ' · then the committee reshares: every share replaced'
            : ' · no reshare: every share stays put',
        ]),
      );
    }
    timeline.append(el('li', {}, items));
  }

  const loot = el('ul', { class: 'loot-list' }, run.collected.map((c) =>
    el('li', {}, [
      `${PARTY_LABELS[c.party]} (stolen in epoch ${c.epoch}): `,
      el('code', { text: truncHex(c.value) }),
    ]),
  ));

  const epochsUsed = new Set(run.used.map((c) => c.epoch));
  const usedLabels = run.used.map((c) => `${PARTY_LABELS[c.party]}@${c.epoch}`).join(', ');
  const subsetNote =
    run.used.length === run.collected.length
      ? el('span', {})
      : el('p', { class: 'note' }, [
          el('strong', { text: 'The attacker plays its best move: ' }),
          epochsUsed.size === 1 && run.used.length >= T
            ? `it interpolates only ${usedLabels} — a full quorum inside one epoch beats everything else it holds.`
            : `it interpolates ${usedLabels}. Lagrange divides by (x_i − x_j), so a custodian can only be fed in once no matter how many epochs it was robbed in; the remaining copies are unusable, not merely redundant.`,
        ]);

  let verdict: HTMLElement;
  let explain: string;
  if (run.matchesPublicKey) {
    if (run.reshareOn) {
      verdict = chip('alarm', '✗', `BREACH — ${run.used.length} thefts landed inside epoch ${[...epochsUsed][0]}`);
      explain =
        'The honest limit, computed: resharing resets the clock BETWEEN epochs. It cannot beat a quorum assembled within one epoch — those shares all lie on that epoch’s single polynomial, and refreshing afterwards revokes nothing that already happened.';
    } else {
      verdict = chip('alarm', '✗', 'BREACH — patient, never-simultaneous thefts defeated the threshold');
      explain =
        'The shares never changed, so shares stolen years apart still lie on one polynomial — to the algebra, years apart is the same as one night.';
    }
  } else if (run.used.length < T) {
    verdict = chip('ok', '✓', `HELD — only ${run.used.length} share${run.used.length === 1 ? '' : 's'}: below the threshold of ${T}`);
    explain =
      'Below the threshold nothing reconstructs, reshared or not — that guarantee is plain Shamir (see shamir-gate). Resharing exists for the attacker patient enough to reach t.';
  } else {
    verdict = chip('ok', '✓', 'HELD — the thefts span epochs; the collection is worthless');
    explain =
      `The loot spans epochs ${[...epochsUsed].sort((a, b) => a - b).join(', ')} and no single epoch reached the threshold — points from different polynomials that agree nowhere the attacker can use. Not “revoked”, not “detected”: just algebraically unrelated to the secret.`;
  }

  return [
    el('p', { class: 'note' }, [
      el('strong', { text: 'Thefts: ' }),
      run.steals.map(stealLabel).join(' · '),
    ]),
    timeline,
    el('h4', { text: `The attacker’s loot (${run.collected.length} share${run.collected.length === 1 ? '' : 's'}, t = ${T})` }),
    loot,
    subsetNote,
    el('h4', { text: 'The attacker interpolates at x = 0' }),
    el('p', {}, [el('code', { class: 'inline-hex', text: truncHex(run.reconstructed) })]),
    el('div', { class: 'verdict-pair' }, [
      el('div', { class: 'chip-slot' }, [
        el('h4', { text: 'Cryptographic result' }),
        chip(
          'neutral',
          run.matchesPublicKey ? '✓' : '✗',
          run.matchesPublicKey
            ? 'g^v = Y — MATCH: the interpolated value IS the private scalar s'
            : 'g^v ≠ Y — NO MATCH: the interpolated value is unrelated to s',
        ),
      ]),
      el('div', { class: 'chip-slot' }, [el('h4', { text: 'Security verdict' }), verdict]),
    ]),
    el('p', { class: 'note', text: explain }),
  ];
}

export function adversaryPanel(): HTMLElement {
  const offBtn = el('button', {
    class: 'btn btn-primary',
    id: 'adv-run-off',
    type: 'button',
    text: 'Run 5 epochs WITHOUT resharing',
  });
  const onBtn = el('button', {
    class: 'btn btn-primary',
    id: 'adv-run-on',
    type: 'button',
    text: 'Run 5 epochs WITH resharing',
  });
  const status = el('p', { class: 'seal-status', role: 'status', 'aria-live': 'polite' });
  const offSlot = el('div', { class: 'side-card', id: 'adv-result-off' }, [
    el('h3', { text: 'Without resharing' }),
    el('p', { class: 'note', text: 'Not run yet.' }),
  ]);
  const onSlot = el('div', { class: 'side-card', id: 'adv-result-on' }, [
    el('h3', { text: 'With resharing every epoch' }),
    el('p', { class: 'note', text: 'Not run yet.' }),
  ]);

  // The theft planner: one checkbox per (custodian, epoch).
  const grid = el('div', { class: 'tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Theft planner: choose which shares the attacker copies, and when' }, [
    el('table', { class: 'data-table' }, [
      el('caption', { class: 'sr-only', text: 'Pick the epochs in which the attacker copies each custodian’s share' }),
      el('thead', {}, [
        el('tr', {}, [
          el('th', { scope: 'col', text: 'Custodian' }),
          ...Array.from({ length: EPOCHS }, (_, e) => el('th', { scope: 'col', text: `Epoch ${e + 1}` })),
        ]),
      ]),
      el('tbody', {}, Array.from({ length: PARTIES }, (_, p) =>
        el('tr', {}, [
          el('th', { scope: 'row', text: PARTY_LABELS[p] }),
          ...Array.from({ length: EPOCHS }, (_, e) => {
            const id = `steal-${p}-${e + 1}`;
            const box = el('input', {
              type: 'checkbox',
              id,
              'data-party': String(p),
              'data-epoch': String(e + 1),
              'aria-label': `Attacker copies ${PARTY_LABELS[p]}’s share in epoch ${e + 1}`,
            });
            if (DEFAULT_STEALS.has(`${p}:${e + 1}`)) box.checked = true;
            return el('td', {}, [el('span', { class: 'pick-cell' }, [box])]);
          }),
        ]),
      )),
    ]),
  ]);

  // Every box the learner ticked is a theft the attacker carried out. Nothing
  // is dropped here: an earlier version collapsed repeat custodians to their
  // newest copy before the run, which quietly rewrote the plan — tick A@1,
  // A@5, B@1, C@1 and it ran A@5, B@1, C@1, lost the epoch-1 quorum, and
  // printed "the thefts span epochs; the collection is worthless" about an
  // attacker holding A@1, B@1, C@1 and therefore the key. Choosing which
  // subset of the loot to interpolate is the attacker's job, and
  // runMobileAdversary does it on the real loot.
  function plannedSteals(): Steal[] {
    return Array.from(grid.querySelectorAll<HTMLInputElement>('input:checked'))
      .map((box) => ({ party: Number(box.dataset.party), epoch: Number(box.dataset.epoch) }))
      .sort((a, b) => a.epoch - b.epoch || a.party - b.party);
  }

  async function run(on: boolean): Promise<void> {
    const steals = plannedSteals();
    if (steals.length === 0) {
      status.textContent = 'Plan at least one theft in the grid above.';
      return;
    }
    offBtn.disabled = true;
    onBtn.disabled = true;
    status.textContent =
      (on
        ? `Running 5 epochs with a full reshare between each (thefts: ${steals.map(stealLabel).join(', ')}) — real dealings, real 2048-bit group…`
        : `Running 5 epochs with the shares left alone (thefts: ${steals.map(stealLabel).join(', ')})…`);
    await paint();
    try {
      const result = await runMobileAdversary(on, steals, EPOCHS);
      const slot = on ? onSlot : offSlot;
      slot.replaceChildren(
        el('h3', { text: on ? 'With resharing every epoch' : 'Without resharing' }),
        ...renderRun(result),
      );
      status.textContent = result.matchesPublicKey
        ? 'Done — the attacker holds the private scalar. Verdict and reasons in the card below.'
        : 'Done — the loot interpolates to noise. Verdict and reasons in the card below.';
    } finally {
      offBtn.disabled = false;
      onBtn.disabled = false;
    }
  }

  offBtn.addEventListener('click', () => void run(false));
  onBtn.addEventListener('click', () => void run(true));

  return el('section', { class: 'panel', 'aria-labelledby': 'adv-h' }, [
    el('h2', { id: 'adv-h', text: '3 · The mobile adversary — why resharing exists' }),
    el('p', { class: 'panel-lede' }, [
      'A 3-of-5 threshold does not have to be beaten in one night. Plan the campaign yourself: the default steals A in epoch 1, B in epoch 3, C in epoch 5 — ',
      el('strong', { text: 'never more than one custodian at a time' }),
      ', always below the threshold. Then run the same plan against both worlds. Each run uses a fresh committee and secret.',
    ]),
    grid,
    el('p', { class: 'note' }, [
      'Worth trying: three thefts inside one epoch (resharing loses — and the demo will say so honestly); only two thefts (plain Shamir already wins); the same custodian in every epoch (the attacker learns nothing new).',
    ]),
    el('div', { class: 'controls' }, [offBtn, onBtn]),
    status,
    el('div', { class: 'sides' }, [offSlot, onSlot]),
    el('p', { class: 'honesty' }, [
      'Exactly what “recovered” means here: the interpolated value v satisfies g',
      el('sup', { text: 'v' }),
      ' = Y, so v is the committee’s private scalar. What that scalar authorizes — decrypting, signing, spending — depends on the system built around Y, and this lab deliberately builds none (see ',
      el('a', { href: 'https://systemslibrarian.github.io/crypto-lab-threshold-decrypt/', text: 'threshold-decrypt' }),
      ' and ',
      el('a', { href: 'https://systemslibrarian.github.io/crypto-lab-frost-threshold/', text: 'frost-threshold' }),
      '). And the guarantee’s fine print: it assumes compromised custodians’ old shares are genuinely erased at each refresh — an attacker who can stop the erasure has stopped the defense.',
    ]),
  ]);
}
