/**
 * Exhibit 6 — membership change. Redistribution reshares the same secret from
 * the 3-of-5 committee into a brand-new 4-of-7 committee: new people, new
 * threshold, same key. This is how real custody rotates operators.
 */
import {
  matchesPublicKey,
  publicKey,
  reconstruct,
  redistribute,
} from '../reshare/reshare';
import { chip, el, fullHex, hexRow, paint, truncHex } from './dom';
import { latest, type Session } from './state';

const NEW_LABELS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];

export function membershipPanel(session: Session): HTMLElement {
  const runBtn = el('button', {
    class: 'btn btn-primary',
    id: 'membership-run',
    type: 'button',
    text: 'Reshare 3-of-5 into 4-of-7',
  });
  const status = el('p', { class: 'seal-status', role: 'status', 'aria-live': 'polite' });
  const results = el('div', { id: 'membership-result' });

  runBtn.addEventListener('click', () => {
    void (async () => {
      runBtn.disabled = true;
      status.textContent =
        'Quorum A, B, C each deal their SHARE (never the secret) into a fresh degree-3 polynomial for seven new custodians; verifying every dealing against the old public commitments…';
      await paint();
      try {
        const old = latest(session);
        const { next, verdicts } = await redistribute(old, [0, 1, 2], 4, 7);

        const constOk = verdicts.filter((v) => v.constantTermOk).length;
        const subOk = verdicts.reduce((acc, v) => acc + v.subShareOk.filter(Boolean).length, 0);

        const recNew = reconstruct([0, 1, 2, 3].map((j) => ({ x: BigInt(j + 1), y: next.shares[j] })));
        const below = reconstruct([0, 1, 2].map((j) => ({ x: BigInt(j + 1), y: next.shares[j] })));
        const pkSame = publicKey(next) === publicKey(old);

        results.replaceChildren(
          el('p', { class: 'panel-lede' }, [
            el('strong', { text: 'Dealings verified: ' }),
            `${constOk}/3 dealers proved D₀ = g^(sᵢ) — checked against the OLD epoch’s public commitments, so no share was revealed to check it · ${subOk}/21 Feldman sub-share checks passed.`,
          ]),
          el('div', { class: 'party-row', role: 'list', 'aria-label': 'New committee shares' }, next.shares.map((share, j) =>
            el('div', { class: 'party-card', role: 'listitem' }, [
              el('p', { class: 'party-name', text: `${NEW_LABELS[j]} (x = ${j + 1})` }),
              el('code', { class: 'party-share', text: truncHex(share) }),
            ]),
          )),
          el('div', { class: 'sides' }, [
            el('div', { class: 'side-card' }, [
              el('h3', { text: 'Same key' }),
              hexRow('Any 4 of the 7 new shares reconstruct:', fullHex(recNew)),
              hexRow('The secret the old committee held:', fullHex(session.secret)),
              recNew === session.secret
                ? chip('ok', '✓', 'Byte-identical — seven strangers now guard the same secret')
                : chip('alarm', '✗', 'MISMATCH — redistribution corrupted the secret'),
              pkSame
                ? chip('ok', '✓', 'Public key unchanged: C′₀ = ∏ (g^(sᵢ))^(λᵢ) = g^s = Y')
                : chip('alarm', '✗', 'PUBLIC KEY MOVED'),
            ]),
            el('div', { class: 'side-card' }, [
              el('h3', { text: 'New threshold, enforced' }),
              el('p', {}, [
                'Three new shares — enough under the old rules — interpolate to ',
                el('code', { class: 'inline-hex', text: truncHex(below) }),
                ':',
              ]),
              chip(
                'neutral',
                matchesPublicKey(below, publicKey(next)) ? '✓' : '✗',
                matchesPublicKey(below, publicKey(next))
                  ? 'g^v = Y — MATCH (unexpected!)'
                  : 'g^v ≠ Y — NO MATCH: three shares are no longer a quorum',
              ),
              el('p', {
                class: 'note',
                text:
                  'The threshold rode along with the reshare: the new polynomial has degree 3, so it takes 4 points to pin it down. Growing the committee and raising the bar happened in the same move, without the secret ever existing in one place.',
              }),
            ]),
          ]),
          el('p', {
            class: 'note',
            text:
              'This panel forks the timeline: the 5-party committee in panels 1 and 4 keeps its own history. In production this IS the retirement ceremony — the old custodians erase their shares afterward, and the new seven never saw them.',
          }),
        );
        status.textContent = 'Redistribution complete: same secret, same public key, seven new custodians, threshold now 4.';
      } finally {
        runBtn.disabled = false;
      }
    })();
  });

  return el('section', { class: 'panel', 'aria-labelledby': 'member-h' }, [
    el('h2', { id: 'member-h', text: '6 · Rotate the committee — 3-of-5 becomes 4-of-7' }),
    el('p', { class: 'panel-lede' }, [
      'Real custody does not keep the same five operators forever. Redistribution is resharing with new coordinates: a quorum of three old custodians each deal ',
      el('em', { text: 'their share' }),
      ' into a fresh polynomial for the incoming committee, and the incoming committee combines what it receives with public Lagrange weights. Same secret, new people, new threshold — and the old committee’s shares become one more expired epoch.',
    ]),
    el('div', { class: 'seal-row' }, [runBtn]),
    status,
    results,
  ]);
}
