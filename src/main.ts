import './styles.css';
import { adversaryPanel } from './ui/adversary';
import { breakitPanel } from './ui/breakit';
import { cheatPanel } from './ui/cheat';
import { circlePanel } from './ui/circle';
import { el } from './ui/dom';
import { introPanel, scopePanel } from './ui/intro';
import { mechanismPanel } from './ui/mechanism';
import { membershipPanel } from './ui/membership';
import { createSession } from './ui/state';

const app = document.getElementById('app');
if (!app) throw new Error('missing #app mount point');

const main = el('main', { class: 'lab-main' }, [
  el('p', { class: 'seal-status', role: 'status', text: 'Dealing the initial 3-of-5 sharing…' }),
]);
app.append(main);

void (async () => {
  const session = await createSession();
  main.replaceChildren(
    introPanel(),
    circlePanel(session),
    mechanismPanel(),
    adversaryPanel(),
    breakitPanel(session),
    cheatPanel(session),
    membershipPanel(session),
    scopePanel(),
  );
})();
