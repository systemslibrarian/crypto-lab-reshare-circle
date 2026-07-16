/**
 * Exhibit 1 — the headline: turn the epoch. Runs the real HJKY refresh in the
 * real 2048-bit group, verifies every dealing, then proves the three claims
 * side by side: every share changed, the reconstructed secret is
 * byte-identical, the public key never moved.
 */
import {
  G,
  P,
  PARTY_LABELS,
  commitmentEval,
  publicKey,
  reconstruct,
  refreshEpoch,
} from '../reshare/reshare';
import { modPow } from '../reuse/vss';
import { chip, el, fullHex, hexRow, paint, truncHex } from './dom';
import { latest, pushEpoch, type Session } from './state';

export function circlePanel(session: Session): HTMLElement {
  const stateView = el('div', {});
  const status = el('p', { class: 'seal-status', role: 'status', 'aria-live': 'polite' });
  const results = el('div', { id: 'reshare-compare' });
  const btn = el('button', {
    class: 'btn btn-primary',
    id: 'advance-epoch',
    type: 'button',
    text: 'Advance epoch (reshare)',
  });

  function renderState(): void {
    const cur = latest(session);
    stateView.replaceChildren(
      el('div', { class: 'kv-strip' }, [
        el('p', { class: 'kv-item' }, [
          el('strong', { text: `Epoch ${cur.epoch}` }),
          ` · ${cur.t}-of-${cur.n} committee`,
        ]),
        el('p', { class: 'kv-item' }, [
          'Public key Y = g',
          el('sup', { text: 's' }),
          ` : `,
          el('code', { class: 'inline-hex', text: truncHex(publicKey(cur)) }),
        ]),
      ]),
      el('div', { class: 'party-row', role: 'list', 'aria-label': 'Current shares by custodian' }, cur.shares.map((share, j) =>
        el('div', { class: 'party-card', role: 'listitem' }, [
          el('p', { class: 'party-name', text: `${PARTY_LABELS[j]} (x = ${j + 1})` }),
          el('code', { class: 'party-share', text: truncHex(share) }),
        ]),
      )),
    );
  }

  btn.addEventListener('click', () => {
    void (async () => {
      btn.disabled = true;
      const prev = latest(session);
      status.textContent = `Epoch ${prev.epoch} → ${prev.epoch + 1}: each of the 5 parties deals a zero-constant update; running 5 zero-commitment checks and 25 Feldman sub-share checks in the real 2048-bit group…`;
      await paint();
      try {
        const { next, dealings, verdicts } = await refreshEpoch(prev);

        const zeroOk = verdicts.filter((v) => v.zeroCommitmentOk).length;
        const subOk = verdicts.reduce((acc, v) => acc + v.subShareOk.filter(Boolean).length, 0);

        // Audit view only: the protocol itself never interpolates f(0).
        const quorum = [0, 1, 2];
        const recPrev = reconstruct(quorum.map((j) => ({ x: BigInt(j + 1), y: prev.shares[j] })));
        const recNext = reconstruct(quorum.map((j) => ({ x: BigInt(j + 1), y: next.shares[j] })));
        const secretsEqual = recPrev === recNext;
        const pkEqual = publicKey(next) === publicKey(prev);
        const newSharesVerify = next.shares.every(
          (s, j) => commitmentEval(next.commitments, BigInt(j + 1)) === modPow(G, s, P),
        );

        const compareTable = el('table', { class: 'data-table' }, [
          el('caption', { class: 'sr-only', text: 'Shares before and after the reshare' }),
          el('thead', {}, [
            el('tr', {}, [
              el('th', { scope: 'col', text: 'Custodian' }),
              el('th', { scope: 'col', text: `Epoch ${prev.epoch} share` }),
              el('th', { scope: 'col', text: `Epoch ${next.epoch} share` }),
              el('th', { scope: 'col', text: 'Changed?' }),
            ]),
          ]),
          el('tbody', {}, prev.shares.map((oldShare, j) =>
            el('tr', {}, [
              el('th', { scope: 'row', text: PARTY_LABELS[j] }),
              el('td', {}, [el('code', { text: truncHex(oldShare) })]),
              el('td', {}, [el('code', {}, [el('mark', { text: truncHex(next.shares[j]) })])]),
              el('td', { text: next.shares[j] !== oldShare ? 'yes — completely new value' : 'NO (unexpected!)' }),
            ]),
          )),
        ]);

        const dealingMatrix = el('details', { class: 'expert' }, [
          el('summary', { text: 'Every dealing, sub-share and check (the full round)' }),
          el('div', { class: 'tablewrap', tabindex: '0', role: 'region', 'aria-label': 'Reshare dealing matrix' }, [
            el('table', { class: 'data-table' }, [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { scope: 'col', text: 'Dealer' }),
                  el('th', { scope: 'col', text: 'D₀ (commitment to δ(0))' }),
                  el('th', { scope: 'col', text: 'Zero check D₀ = 1' }),
                  ...PARTY_LABELS.slice(0, next.n).map((l) =>
                    el('th', { scope: 'col', text: `sub-share → ${l}` }),
                  ),
                ]),
              ]),
              el('tbody', {}, dealings.map((d, i) =>
                el('tr', {}, [
                  el('th', { scope: 'row', text: PARTY_LABELS[d.dealer] }),
                  el('td', {}, [el('code', { text: d.commitments[0] === 1n ? '1 (identity)' : truncHex(d.commitments[0]) })]),
                  el('td', { text: verdicts[i].zeroCommitmentOk ? '✓ pass' : '✗ FAIL' }),
                  ...d.subShares.map((s, j) =>
                    el('td', {}, [
                      el('code', { text: truncHex(s) }),
                      ` ${verdicts[i].subShareOk[j] ? '✓' : '✗'}`,
                    ]),
                  ),
                ]),
              )),
            ]),
          ]),
          el('p', {
            class: 'note',
            text:
              'In a real deployment each column of sub-shares travels over a private channel to its custodian; the commitments row is broadcast. Values are truncated for display — the full 2048-bit arithmetic ran in your browser.',
          }),
        ]);

        results.replaceChildren(
          el('p', { class: 'panel-lede' }, [
            el('strong', { text: 'Round verified: ' }),
            `${zeroOk}/5 dealings committed to a zero constant term (D₀ = 1) · ${subOk}/25 Feldman sub-share checks passed · new shares verify against the updated public commitments: ${newSharesVerify ? '5/5 ✓' : 'FAILED ✗'}.`,
          ]),
          compareTable,
          el('div', { class: 'sides' }, [
            el('div', { class: 'side-card' }, [
              el('h3', { text: 'The secret (audit view)' }),
              hexRow(`Reconstructed from A, B, C — epoch ${prev.epoch}:`, fullHex(recPrev)),
              hexRow(`Reconstructed from A, B, C — epoch ${next.epoch}:`, fullHex(recNext)),
              secretsEqual
                ? chip('ok', '✓', 'Byte-identical — the shares are new numbers, the secret they encode is not')
                : chip('alarm', '✗', 'MISMATCH — the refresh corrupted the secret (this should be impossible)'),
              el('p', {
                class: 'note',
                text:
                  'The protocol never performs these reconstructions — the secret is never assembled anywhere. This page does it, in tab memory only, to prove to you that the two epochs agree.',
              }),
            ]),
            el('div', { class: 'side-card' }, [
              el('h3', { text: 'The public key' }),
              hexRow(`Y before (epoch ${prev.epoch}):`, truncHex(publicKey(prev))),
              hexRow(`Y after (epoch ${next.epoch}):`, truncHex(publicKey(next))),
              pkEqual
                ? chip('ok', '✓', 'Identical (compared in full) — C′₀ = C₀ · ∏ D₀ = Y · ∏ 1 = Y, provably')
                : chip('alarm', '✗', 'PUBLIC KEY MOVED — the sharing no longer encodes the same secret'),
              el('p', {
                class: 'note',
                text:
                  'Anything in the outside world that trusts Y — an address, a certificate, a verifier — keeps working across the reshare, untouched.',
              }),
            ]),
          ]),
          dealingMatrix,
        );

        pushEpoch(session, next);
        renderState();
        status.textContent = `Epoch ${next.epoch} is live. Every share changed; the secret and Y did not. Advance again, or take old shares down to panel 4 and try to mix epochs.`;
      } finally {
        btn.disabled = false;
      }
    })();
  });

  renderState();

  return el('section', { class: 'panel', 'aria-labelledby': 'circle-h' }, [
    el('h2', { id: 'circle-h', text: '1 · Turn the epoch — same secret, brand-new shares' }),
    el('p', { class: 'panel-lede' }, [
      'Five custodians hold a 3-of-5 Shamir sharing of a 256-bit secret ',
      el('em', { text: 's' }),
      ', dealt once by a trusted dealer (that dealer assumption is exactly what a DKG would remove — different lab). The public key Y = g',
      el('sup', { text: 's' }),
      ' is published. To reshare, ',
      el('strong', {
        text:
          'each party independently deals a random polynomial with zero constant term, sends everyone a point on it, and every party adds what it received to its own share',
      }),
      '. No coordinator, no reassembly of the secret — and Feldman commitments let everyone verify every step.',
    ]),
    stateView,
    el('div', { class: 'seal-row' }, [btn]),
    status,
    results,
  ]);
}
