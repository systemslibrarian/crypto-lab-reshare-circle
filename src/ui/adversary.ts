/**
 * Exhibit 3 — the mobile adversary. The same three thefts, run twice against
 * real crypto: once against a committee that never reshares, once against one
 * that reshares every epoch. The cryptographic result (does g^v equal Y?) and
 * the security verdict are rendered as SEPARATE indicators — the point of the
 * lab is the run where the math says MATCH and the verdict screams BREACH.
 */
import { PARTY_LABELS, runMobileAdversary } from '../reshare/reshare';
import type { AdversaryRun, Steal } from '../reshare/types';
import { chip, el, paint, truncHex } from './dom';

const STEALS: Steal[] = [
  { epoch: 1, party: 0 },
  { epoch: 3, party: 1 },
  { epoch: 5, party: 2 },
];
const EPOCHS = 5;

function renderRun(run: AdversaryRun): HTMLElement[] {
  const timeline = el('ol', { class: 'timeline' }, []);
  for (let e = 1; e <= EPOCHS; e++) {
    const items: Array<Node | string> = [el('strong', { text: `Epoch ${e}` })];
    const steal = STEALS.find((s) => s.epoch === e);
    if (steal) {
      items.push(
        el('span', { class: 'steal-note' }, [
          ` — attacker copies ${PARTY_LABELS[steal.party]}’s current share`,
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

  return [
    timeline,
    el('h4', { text: 'The attacker’s loot (3 shares, t = 3)' }),
    loot,
    el('h4', { text: 'The attacker interpolates the loot at x = 0' }),
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
      el('div', { class: 'chip-slot' }, [
        el('h4', { text: 'Security verdict' }),
        run.matchesPublicKey
          ? chip('alarm', '✗', 'BREACH — three patient, never-simultaneous thefts defeated the 3-of-5 threshold')
          : chip('ok', '✓', 'HELD — three shares from three different sharings; the collection is worthless'),
      ]),
    ]),
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

  async function run(on: boolean): Promise<void> {
    offBtn.disabled = true;
    onBtn.disabled = true;
    status.textContent = on
      ? 'Running 5 epochs with a full reshare between each — real dealings, real 2048-bit group…'
      : 'Running 5 epochs with the shares left alone…';
    await paint();
    try {
      const result = await runMobileAdversary(on, STEALS, EPOCHS);
      const slot = on ? onSlot : offSlot;
      slot.replaceChildren(
        el('h3', { text: on ? 'With resharing every epoch' : 'Without resharing' }),
        ...renderRun(result),
      );
      status.textContent = on
        ? 'Done. Same thefts, same threshold — but each stolen share came from a different polynomial, so the loot interpolates to noise.'
        : 'Done. The shares never changed, so shares stolen years apart still lie on one polynomial — and t of them are the key.';
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
      'A 3-of-5 threshold does not have to be beaten in one night. This attacker compromises custodian A in epoch 1, B in epoch 3, C in epoch 5 — ',
      el('strong', { text: 'never holding more than one custodian at a time' }),
      ', always below the threshold. Each run below uses a fresh committee and a fresh secret; run both and compare.',
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
      '). Two limits to be honest about: resharing resets the clock but cannot undo a breach that reaches t shares within a single epoch, and the guarantee assumes compromised custodians’ old shares are genuinely erased at each refresh.',
    ]),
  ]);
}
