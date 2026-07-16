/** Plain-language on-ramp + honest scoping, before any hex appears. */
import { el } from './dom';

const LAB = (repo: string) => `https://systemslibrarian.github.io/crypto-lab-${repo}/`;

export function introPanel(): HTMLElement {
  const expert = el('details', { class: 'expert' }, [
    el('summary', { text: 'The fine print (for the cryptographer)' }),
    el('ul', { class: 'scope-list' }, [
      el('li', {
        text:
          'Protocol: HJKY share refresh (Herzberg, Jarecki, Krawczyk, Yung — “Proactive Secret Sharing, or: How to Cope with Perpetual Leakage”, CRYPTO 1995), plus share redistribution to a new (t′, n′) committee. Shares are Shamir over Z_q; update polynomials have zero constant term; dealings carry Feldman commitments.',
      }),
      el('li', {
        text:
          'Group: RFC 3526 group 14 — p is a 2048-bit safe prime, q = (p − 1)/2, g = 4 generates the order-q subgroup. Consumed verbatim from the vss-gate lab; the Shamir field arithmetic is consumed verbatim from shamir-gate.',
      }),
      el('li', {
        text:
          'Adversary model: a mobile adversary that may compromise fewer than t parties within any single epoch, but different parties across epochs. Proactive security additionally assumes parties truly erase old shares at each refresh, that sub-shares travel over private channels, that commitments are broadcast consistently, and that epochs are synchronized. Violate any of those and the guarantee is off.',
      }),
      el('li', {
        text:
          'Feldman commitments reveal g^(a_k), so share secrecy here is computational (discrete log), not information-theoretic. The Pedersen variant that hides even that is taught in vss-gate.',
      }),
      el('li', {
        text:
          'This page simulates all five parties in one browser tab, so “private channels” are trivially private. Nothing here models a network, timeouts, or Byzantine agreement about who cheated.',
      }),
    ]),
  ]);

  return el('section', { class: 'panel', 'aria-labelledby': 'intro-h' }, [
    el('h2', { id: 'intro-h', text: 'What is proactive resharing?' }),
    el('p', { class: 'panel-lede' }, [
      'A threshold scheme splits a secret key among ',
      el('em', { text: 'n' }),
      ' custodians so that any ',
      el('em', { text: 't' }),
      ' of them can act and fewer than ',
      el('em', { text: 't' }),
      ' learn nothing. That defends a moment in time. But keys live for years — and an attacker with years doesn’t need ',
      el('em', { text: 't' }),
      ' break-ins at once. One custodian this year, another next year, and the quorum is quietly theirs.',
    ]),
    el('p', { class: 'panel-lede' }, [
      'Proactive resharing resets that clock. On a schedule, the custodians jointly scramble their shares into fresh ones — ',
      el('strong', { text: 'without the secret ever being put back together' }),
      '. The secret and its public key stay exactly the same, every share changes, and anything stolen in a past epoch stops counting toward the threshold.',
    ]),
    el('p', { class: 'honesty' }, [
      'Everything on this page runs real cryptography in your browser: Shamir sharing over the 2048-bit RFC 3526 group with Feldman-commitment verification, consumed from the ',
      el('a', { href: LAB('shamir-gate'), text: 'shamir-gate' }),
      ' and ',
      el('a', { href: LAB('vss-gate'), text: 'vss-gate' }),
      ' labs rather than reimplemented. Key material is generated per visit and lives only in this tab’s memory. It is a teaching demo — not production custody software, and it does not model the network a real committee would need.',
    ]),
    el('p', { class: 'note' }, [
      'This is not a DKG lab: the very first split below comes from a trusted dealer, stated as such. Removing that dealer is distributed key generation — taught in ',
      el('a', { href: LAB('gg20-wallet'), text: 'gg20-wallet' }),
      ', ',
      el('a', { href: LAB('threshold-decrypt'), text: 'threshold-decrypt' }),
      ' and ',
      el('a', { href: LAB('vss-gate'), text: 'vss-gate' }),
      '.',
    ]),
    expert,
  ]);
}

export function scopePanel(): HTMLElement {
  const card = (title: string, body: string, links: Array<[string, string]>) =>
    el('div', { class: 'nongoal-card' }, [
      el('h3', { text: title }),
      el('p', { text: body }),
      el('p', { class: 'nongoal-link' }, [
        'See instead: ',
        ...links.flatMap(([name, href], i) => [
          i > 0 ? ', ' : '',
          el('a', { href, text: name }),
        ]),
      ]),
    ]);

  return el('section', { class: 'panel', 'aria-labelledby': 'scope-h' }, [
    el('h2', { id: 'scope-h', text: 'What this lab is not' }),
    el('p', {
      class: 'panel-lede',
      text:
        'Each of these is genuinely adjacent — and each is a different mechanism with its own lab. Resharing starts from a secret that already exists and keeps it alive; it does not create keys, use keys, or survive a hostile network.',
    }),
    el('div', { class: 'nongoal-grid' }, [
      card(
        'Not distributed key generation',
        'The first sharing here comes from a trusted dealer. DKG removes that dealer by having every party act as a dealer at once — related algebra, different protocol and different failure modes.',
        [
          ['gg20-wallet', LAB('gg20-wallet')],
          ['threshold-decrypt', LAB('threshold-decrypt')],
          ['vss-gate', LAB('vss-gate')],
        ],
      ),
      card(
        'Not threshold signing or decryption',
        'Nothing on this page signs or decrypts. Using a shared secret without reconstructing it is its own discipline, with its own attacks.',
        [
          ['frost-threshold', LAB('frost-threshold')],
          ['shamir-vs-frost', LAB('shamir-vs-frost')],
          ['threshold-mldsa', LAB('threshold-mldsa')],
        ],
      ),
      card(
        'Not asynchronous or Byzantine resharing',
        'Messages here arrive instantly, privately, and in order, because all five parties live in one browser tab. Real committees need broadcast agreement and complaint rounds this lab deliberately does not model.',
        [['the Crypto Lab catalog', 'https://crypto-lab.systemslibrarian.dev/']],
      ),
    ]),
  ]);
}
