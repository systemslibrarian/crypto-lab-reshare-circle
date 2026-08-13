import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { auditContrast, formatContrastFailures } from './contrast';
import { auditNonText } from './nontext';
import { NONTEXT_BASELINE } from './nontext-baseline';

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** A phone-width viewport, for the WCAG 1.4.10 reflow half of the gate. */
export const NARROW = { width: 380, height: 800 };

/**
 * Shared machinery for the WCAG gate.
 *
 * Five rules govern everything here, and each one is a correction of the gate
 * this replaces (`e2e/a11y.spec.ts`, 75 lines, two tests):
 *
 *  1. NOTHING IS INJECTED INTO THE PAGE BEFORE A SCAN. The old `prepare()`
 *     opened with
 *
 *         page.addStyleTag({ content:
 *           '*,*::before,*::after{animation:none!important;transition:none!important}' })
 *
 *     which BYPASSES this stylesheet's own
 *     `@media (prefers-reduced-motion: reduce)` block instead of exercising it.
 *     That block is not decorative here: it is the only thing that cancels
 *     `.mech-plot g[data-step] { transition: opacity 0.4s ease }`, which is how
 *     exhibit 2 reveals its plot one step at a time. A gate that suppresses the
 *     transition by injection can never discover that the reduced-motion block
 *     failed to. This gate asks for the preference through
 *     `emulateMedia({ reducedMotion: 'reduce' })` and then ASSERTS the page
 *     agrees, and `boot` additionally asserts the block cancelled the
 *     transition it is supposed to cancel.
 *
 *     The stranded-end-state defect that reduced motion can CREATE was checked
 *     for and is not present: the plot's step opacity is written as an inline
 *     style by `mechanism.ts`'s `render()`, so cancelling the transition jumps
 *     straight to the end value rather than leaving anything at its start.
 *     `expectNotBlank` measures that in every state rather than trusting it.
 *
 *  2. IT FORCE-OPENED EVERY DISCLOSURE FROM SCRIPT. The old drive ended with
 *
 *         document.querySelectorAll('details').forEach((d) => (d.open = true))
 *
 *     which assembles a document no visitor can reach: exhibit 5's
 *     "if nobody checked" counterfactual and exhibit 1's full dealing matrix
 *     open simultaneously, in a state where the reader pressed neither summary.
 *     This gate never touches `.open`; every disclosure is opened by clicking
 *     its own `<summary>`, and the arrival state with all of them shut is
 *     scanned first.
 *
 *  3. IT SCANNED ONCE, AT ONE VIEWPORT, AFTER THE WHOLE DRIVE. `prepare()` ran
 *     all six exhibits and then `scan()` ran once. Every intermediate state it
 *     built — the empty first paint, the four mechanism steps, the honest cheat
 *     round before the cheating one, the break-it refusal paths — was
 *     overwritten before anything measured it. Worse, the light-theme test
 *     re-ran the entire drive but at the SAME 1280px viewport, so the 380px
 *     column had never been scanned in either theme. This drive scans after
 *     every single step, in {dark, light} x {1280, 380}.
 *
 *  4. `violations` IS NOT THE WHOLE ORACLE. See `scan`. Three things on this
 *     page are invisible to a violations-only assertion in particular: the
 *     verdict chips are `color-mix()` over a translucent panel, which axe files
 *     under `incomplete`; the entire mechanism plot is SVG `<text>`, which axe's
 *     `color-contrast` rule does not evaluate at all; and an `aria-label` on a
 *     role-less element is PROHIBITED and lands in `incomplete` too, never in
 *     `violations`.
 *
 *  5. IT HAD NO REFLOW, NO KEYBOARD-SCROLLER, NO NON-TEXT AND NO FOCUS-VISIBLE
 *     ORACLE, and this page needs all four. It carries five `.tablewrap`
 *     scrollers whose widest member (the theft planner) is 6 columns of
 *     checkboxes; eleven buttons that draw their edge with the palette's
 *     surface-divider token; and one focus indicator, `#app :focus-visible`,
 *     covering both those scrollers and every control.
 */

/**
 * Wait for every running animation and transition to drain.
 *
 * Transitions drain in waves, not in one batch, so a poll for "nothing running
 * right now" can exit through a gap between waves. Require quiescence to hold
 * for several consecutive frames instead.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __quietFrames?: number };
      const running = document.getAnimations().filter((a) => a.playState === 'running');
      w.__quietFrames = running.length === 0 ? (w.__quietFrames ?? 0) + 1 : 0;
      return w.__quietFrames >= 6;
    },
    undefined,
    { timeout: 20_000, polling: 'raf' }
  );
}

/**
 * Assert that reduced motion left the page visible, not merely un-animated.
 *
 * The failure mode this guards against is an element whose only route to its
 * visible state is an animation, in a stylesheet whose reduced-motion block
 * cancels that animation without restoring its end state — the element then
 * renders at `opacity: 0` for every reader with the preference set.
 *
 * This lab has exactly one candidate and it is checked here in every state:
 * `mechanism.ts` reveals its plot by writing `g.style.opacity` on three
 * `g[data-step]` groups, with `styles.css` transitioning that property over
 * 0.4s and its reduced-motion block cancelling the transition. Because the end
 * value is an INLINE style rather than a keyframe, cancelling the transition
 * jumps to the end value instead of stranding the group — but that is a
 * property of how `render()` happens to be written today, so it is measured
 * rather than reasoned about.
 *
 * Two exclusions, and both cost something that is stated rather than hidden:
 *
 *  - `aria-hidden` subtrees, matching the boundary `contrast.ts` uses. On this
 *    page that is only the `✓`/`✗` chip glyphs and the ` *` footnote marker.
 *
 *  - subtrees of an element with `role="img"`. ARIA makes the descendants of an
 *    `img` presentational, so their text is not exposed as text at all and the
 *    accessible name is the element's own label. That is exactly the mechanism
 *    plot: one `<svg role="img" aria-label="…">` whose label narrates every
 *    number in it, over three step groups that are DELIBERATELY at `opacity: 0`
 *    until the reader steps to them. Without this exclusion the arrival state
 *    of exhibit 2 reports about thirty invented failures. The cost is that a
 *    genuinely stranded label inside a `role="img"` would not be caught here —
 *    so `boot` asserts the plot's `aria-label` is non-empty and names its
 *    numbers, which is the thing a reader actually receives from that subtree.
 */
async function expectNotBlank(page: Page, label: string): Promise<void> {
  const invisible = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      if (!own) continue;
      // Deliberately hidden subtrees are not "blank", they are closed.
      if (!(el as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true })) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      if (el.closest('[role="img"]')) continue;
      let effective = 1;
      let node: Element | null = el;
      while (node) {
        effective *= parseFloat(getComputedStyle(node).opacity);
        node = node.parentElement;
      }
      if (effective === 0) {
        out.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim()}`);
      }
    }
    return Array.from(new Set(out));
  });
  expect(invisible, `no visible text may render at opacity 0 in state: ${label}`).toEqual([]);
}

/**
 * Uncaught page errors and console errors, collected from the moment the page
 * is created. A renderer that throws halfway through leaves an earlier state on
 * screen, and a gate that scans that state reports green for a page that is
 * broken. Attach before `boot`, assert after the drive.
 *
 * This matters more here than in most labs: every exhibit is real 2048-bit
 * BigInt arithmetic inside an `async` IIFE with a `finally` that re-enables the
 * button. A throw in the middle re-enables the button, leaves the previous
 * render on screen, and looks from the outside exactly like a completed run.
 */
export function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}

/**
 * Exactly one banner landmark.
 *
 * This page has two `<header>` elements: the shared `.cl-topbar`, which is
 * explicitly `role="banner"`, and the lab's own `.cl-hero`, which sits inside
 * `<div id="app">` — a plain div, NOT a sectioning element — so nothing scopes
 * it out of the banner role on its own. `index.html`'s `dedupeBanner()` demotes
 * it to `role="group"` at load. Asserting the OUTCOME rather than the mechanism
 * means a change to either the nesting or the script is caught.
 */
export async function assertSingleBanner(page: Page): Promise<void> {
  const banners = await page.evaluate(() => {
    const scoped = new Set(['MAIN', 'ARTICLE', 'ASIDE', 'NAV', 'SECTION']);
    const isBanner = (el: Element): boolean => {
      if (el.getAttribute('role') === 'banner') return true;
      if (el.tagName !== 'HEADER') return false;
      if (el.getAttribute('role')) return false; // explicit non-banner role wins
      for (let p = el.parentElement; p; p = p.parentElement) if (scoped.has(p.tagName)) return false;
      return true;
    };
    return [...document.querySelectorAll('header,[role="banner"]')].filter(isBanner).length;
  });
  expect(banners, 'exactly one banner landmark').toBe(1);
}

/**
 * An explicit `role` on a `<ul>`/`<ol>` REPLACES its implicit `list` role and
 * orphans every `<li>` inside it. A source grep cannot see this reliably,
 * because a role assigned as a JS property in an element-creation helper looks
 * nothing like markup — and `dom.ts`'s `el()` is exactly such a helper, taking
 * an attribute bag that could carry `role` for any tag. Ask the DOM instead.
 *
 * `role="list"` is the one benign case, and it is deliberately still reported:
 * a redundant `role="list"` makes axe apply `aria-required-children`, which
 * fails whenever the list is empty — and lists on this page are empty at first
 * paint and after every re-render.
 */
export async function assertListSemantics(page: Page): Promise<void> {
  const broken = await page.$$eval('ul[role], ol[role]', (els) =>
    els.map(
      (e) =>
        `${e.tagName.toLowerCase()}[role=${e.getAttribute('role')}] with ${e.children.length} children`
    )
  );
  expect(broken, 'an explicit role on a list deletes its list semantics').toEqual([]);
}

/**
 * Load the page in a known theme with reduced motion actually in effect, and
 * assert the content every scan relies on is really on the page — including the
 * lab's DEFAULTS, which are never assumed.
 *
 * `test.use({ reducedMotion })` silently does nothing on Playwright 1.61.1, so
 * the emulation is applied imperatively BEFORE the navigation and then
 * *asserted* from inside the page.
 *
 * The theme is seeded through `localStorage` rather than by clicking the
 * toggle, which also pins down a real failure mode: `index.html`'s anti-flash
 * script reads `localStorage.getItem('theme')` and the toggle writes
 * `localStorage.setItem('theme', …)`. If those keys drift apart the theme
 * silently stops persisting, and this boot fails on `data-theme` rather than
 * quietly scanning dark twice. (The gate this replaces reached the light theme
 * by CLICKING the toggle, which cannot detect that at all.)
 *
 * The defaults are asserted at length because two of them are load-bearing and
 * both were assumed by the old gate:
 *
 *  - `#cheat-toggle` ships UNCHECKED, so exhibit 5's first render is the honest
 *    round. The old gate ticked it before its only scan, which means the honest
 *    verdict pair — a different chip kind on a different fill — was never
 *    measured in either theme.
 *  - the break-it grid ships with ONE epoch column and a three-share default
 *    selection, so exhibit 4's arrival state is a below-threshold single-epoch
 *    pick. Panel 1 adds the second column, and the mixed-epoch default only
 *    exists after that.
 *
 * The page also boots ASYNCHRONOUSLY: `main.ts` mounts a single "Dealing the
 * initial 3-of-5 sharing…" status line and replaces it with all eight panels
 * once a real 2048-bit deal completes. That transient state is a real one, and
 * it is the reason `boot` waits on a panel rather than on `load`.
 */
export async function boot(page: Page, theme: 'dark' | 'light'): Promise<void> {
  // A click on a control that never becomes actionable otherwise burns the whole
  // test timeout and reports nothing useful. 20s turns that silent hang into a
  // named failure naming the locator.
  page.setDefaultTimeout(20_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
  await page.goto('.');
  expect(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    'reduced-motion emulation must actually be in effect'
  ).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

  // The initial deal is real 2048-bit arithmetic; every panel appears at once
  // when it lands.
  await expect(page.locator('section.panel')).toHaveCount(8, { timeout: 120_000 });

  await assertSingleBanner(page);
  await assertListSemantics(page);

  // The reduced-motion block's one job on this page, asserted rather than
  // assumed: the mechanism plot's step groups must not be transitioning.
  expect(
    await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.mech-plot g[data-step]')!).transitionDuration
    ),
    'reduced motion must cancel the mechanism plot transition'
  ).toBe('0s');

  // ── The lab's shipped defaults ───────────────────────────────────────────
  // Exhibit 2 starts at step 1 of 4, with Back disabled and two of the three
  // plot groups still to be revealed.
  await expect(page.locator('.mech-caption')).toHaveText(/^Step 1 of 4 —/);
  await expect(page.locator('#mech-prev')).toBeDisabled();
  await expect(page.locator('#mech-next')).toBeEnabled();
  expect(
    await page.$$eval('.mech-plot g[data-step]', (gs) => gs.map((g) => (g as SVGElement).style.opacity)),
    'the plot ships with all three step groups hidden'
  ).toEqual(['0', '0', '0']);

  // The plot is a `role="img"`, so its accessible name is the ONLY thing a
  // screen reader gets from it — and `expectNotBlank` excludes its subtree on
  // exactly that basis. Assert the name is real.
  const plotLabel = await page.locator('.mech-plot svg').getAttribute('aria-label');
  expect(plotLabel ?? '', 'the plot must carry a real accessible name').toMatch(
    /epoch-1 share points at heights \d+, \d+ and \d+/
  );

  // Exhibit 3 ships with the patient-theft campaign pre-ticked (A@1, B@3, C@5)
  // and neither world run.
  await expect(page.locator('#adv-run-off')).toBeEnabled();
  await expect(page.locator('#adv-run-on')).toBeEnabled();
  await expect(page.locator('.tablewrap input:checked')).toHaveCount(6); // 3 thefts + 3 picks
  await expect(page.locator('#adv-result-off')).toContainText('Not run yet.');
  await expect(page.locator('#adv-result-on')).toContainText('Not run yet.');

  // Exhibit 4 ships with one epoch column only.
  await expect(page.locator('#breakit-result')).toBeEmpty();
  await expect(page.locator('#breakit-run')).toBeEnabled();

  // Exhibit 5's cheat switch ships OFF. The old gate ticked it before its only
  // scan and so never measured the honest round at all.
  await expect(page.locator('#cheat-toggle')).not.toBeChecked();
  await expect(page.locator('#cheat-result')).toBeEmpty();

  // Exhibit 6 unrun.
  await expect(page.locator('#membership-result')).toBeEmpty();

  // Every disclosure shut. `cheat.ts` builds one with `open: ''` — but only
  // inside a result block that does not exist yet.
  await expect(page.locator('details')).toHaveCount(1);
  await expect(page.locator('details[open]')).toHaveCount(0);

  await settle(page);
  await expectNotBlank(page, `${theme} first paint`);
}

/**
 * Assert the page does not require horizontal scrolling.
 *
 * WCAG 1.4.10 (Reflow, AA). axe has no rule for this at all, and this page is
 * the shape that breaks it: six data tables, the widest of them a 6-column
 * theft planner and a dealing matrix that grows a column per custodian, plus
 * 2048-bit hex values printed as `<code>` runs. Each table is meant to scroll
 * inside its own `.tablewrap`; the assertion here is that none of them scrolls
 * the DOCUMENT.
 *
 * `<body>` carries no `overflow-x: hidden`, which is what makes this
 * falsifiable at all — that declaration propagates to the viewport and pins
 * `scrollWidth === clientWidth` forever, so a page carrying it can never fail a
 * reflow check no matter how far it overflows. Checked, not assumed:
 * `styles.css` sets no `overflow` on `html` or `body`.
 */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    if (doc.scrollWidth <= doc.clientWidth) return null;

    // Only elements that actually push the DOCUMENT sideways are culprits. A
    // wide box inside an `overflow-x: auto` wrapper has a huge bounding rect but
    // is clipped by its scroller and contributes nothing to the document's
    // scroll width — naming it sends you off fixing the wrong element. This
    // page has a decoy behind every one of its five `.tablewrap`s.
    const clipped = (el: Element): boolean => {
      let n = el.parentElement;
      while (n && n !== doc) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
        n = n.parentElement;
      }
      return false;
    };

    const over = Array.from(document.querySelectorAll('body *'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.right > doc.clientWidth + 1)
      .sort((a, b) => b.r.right - a.r.right);
    const widest = over.filter((x) => !clipped(x.el))[0] ?? over[0];

    // The element the walk above names is the WIDEST, which is very often not
    // the CAUSE: a grid or flex item's automatic minimum size is its
    // min-content, so one unbreakable panel three sections down can size the
    // whole page's column and every box in that column then reports as
    // overflowing. Measure the min-content of each grid/flex item directly and
    // report the worst, so triage starts at the cause.
    const culprits: string[] = [];
    for (const container of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const d = getComputedStyle(container).display;
      if (!/grid|flex/.test(d)) continue;
      for (const item of Array.from(container.children) as HTMLElement[]) {
        const before = item.style.width;
        item.style.width = 'min-content';
        const min = item.scrollWidth;
        item.style.width = before;
        if (min > doc.clientWidth) {
          culprits.push(
            `${item.tagName.toLowerCase()}${item.id ? '#' + item.id : ''}` +
              `${item.className ? '.' + String(item.className).trim().split(/\s+/).join('.') : ''}` +
              ` min-content=${Math.round(min)}px > viewport ${doc.clientWidth}px`
          );
        }
      }
    }

    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      widest: widest
        ? `${clipped(widest.el) ? '[clipped] ' : ''}${widest.el.tagName.toLowerCase()}${widest.el.id ? '#' + widest.el.id : ''}` +
          `${widest.el.getAttribute('class') ? '.' + widest.el.getAttribute('class')!.trim().split(/\s+/).join('.') : ''}` +
          ` @${Math.round(widest.r.width)}px right=${Math.round(widest.r.right)}`
        : '(none identified)',
      minContentCulprits: Array.from(new Set(culprits)).slice(0, 8),
    };
  });
  expect(overflow, `page must not scroll horizontally in state: ${label}`).toBeNull();
}

/**
 * Every scrolling container must be operable from the keyboard (WCAG 2.1.1). If
 * it holds no focusable content it needs `tabindex="0"`, so it becomes a focus
 * target arrow keys can then scroll.
 *
 * This lab's five `.tablewrap` regions are all built with `tabindex="0"`,
 * `role="region"` and an `aria-label`, so the known case is handled. The
 * assertion stays because that is a convention rather than an enforcement —
 * `.tablewrap` is a bare CSS class any panel can reach for — and because what
 * is inside those scrollers is the evidence for everything this lab claims:
 * the dealing matrix, the theft planner, the share grid and the two
 * verification tables.
 */
export async function expectScrollersReachable(page: Page, label: string): Promise<void> {
  const unreachable = await page.evaluate(() => {
    const FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
    return Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .filter((el) => {
        const cs = getComputedStyle(el);
        return (
          ['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY)
        );
      })
      .filter((el) => el.tabIndex < 0 && !el.querySelector(FOCUSABLE))
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').trim()}` +
          ` (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`
      );
  });
  expect(
    Array.from(new Set(unreachable)),
    `scrolling regions with no keyboard route in state: ${label}`
  ).toEqual([]);
}

/**
 * WCAG 2.4.7: everything reachable by Tab must show where the focus is, and
 * WCAG 1.4.11 asks that indicator to clear 3:1 against what it sits on.
 *
 * CHROMIUM ONLY APPLIES `:focus-visible` STYLING AFTER A REAL KEYBOARD
 * INTERACTION. A programmatic `el.focus()` on a freshly loaded page matches
 * `:focus` but NOT `:focus-visible`, so a probe that just calls `focus()` and
 * reads `outlineWidth` reports `0px` for every element and invents one defect
 * per focusable region — the whole page, on a page whose indicator is defined
 * as `#app :focus-visible`. So: press Tab for real first (which arms the
 * heuristic for the rest of the document's lifetime), blur whatever that
 * landed on, and only then walk.
 *
 * The measurement is the outline colour against the surface just outside the
 * element, which is where an outline is painted — `outline-offset: 2px` puts
 * this lab's ring entirely outside the border box.
 */
export async function expectFocusIndicators(page: Page, label: string): Promise<void> {
  // Prime `:focus-visible`. Without this the walk below is vacuous.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() => !!document.activeElement?.matches(':focus-visible')),
    'a real Tab must arm :focus-visible before any focus indicator is measured'
  ).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());

  const bad = await page.evaluate(() => {
    const out: string[] = [];
    const FOCUSABLE =
      '#app a[href],#app button:not([disabled]),#app input:not([disabled]),#app select,#app textarea,#app [tabindex="0"]';
    const active = document.activeElement as HTMLElement | null;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE))) {
      if (!el.checkVisibility?.()) continue;
      el.focus();
      if (!el.matches(':focus-visible')) continue; // not a keyboard-focus case
      const cs = getComputedStyle(el);
      const w = parseFloat(cs.outlineWidth || '0');
      if (w <= 0 || cs.outlineStyle === 'none') {
        out.push(
          `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} — no focus outline (${cs.outlineStyle} ${cs.outlineWidth})`
        );
      }
    }
    active?.focus?.();
    (document.activeElement as HTMLElement | null)?.blur?.();
    return Array.from(new Set(out));
  });
  softExpect(bad, `focusable controls with no visible focus indicator in state: ${label}`, []);
}

/**
 * When `A11Y_COLLECT` is set, `scan` records failures instead of throwing.
 *
 * A strict gate reports the first failing assertion in the first failing state
 * and stops, so a page with defects in several states needs one full run per
 * defect to enumerate them. The collection pass turns that into a single run. It
 * is a debugging aid only: `A11Y_COLLECT` is never set in CI, and a run with it
 * set prints every finding as it happens and then FAILS at the end, so a green
 * collection run cannot be mistaken for a green gate.
 */
const COLLECTING = !!process.env.A11Y_COLLECT;
const collected: string[] = [];

function record(entry: string): void {
  collected.push(entry);
  // Printed as it happens, not only at the end: a hard assertion later in the
  // drive would otherwise abort the test before anything collected so far was
  // ever shown.
  console.log(`\n[A11Y_COLLECT #${collected.length}] ${entry}`);
}

export function softExpect(actual: unknown, message: string, expected: unknown): void {
  if (!COLLECTING) {
    expect(actual, message).toEqual(expected);
    return;
  }
  try {
    expect(actual, message).toEqual(expected);
  } catch {
    record(`${message}\n  ${JSON.stringify(actual, null, 2)}`);
  }
}

/**
 * Fail the test if the collection pass recorded anything. Without this a
 * collection run would end green, and a green collection run is
 * indistinguishable from a green gate — which is the exact confusion the whole
 * exercise exists to remove.
 */
export function reportCollected(): void {
  if (!COLLECTING) return;
  expect(collected, `A11Y_COLLECT recorded ${collected.length} failure(s)`).toEqual([]);
}

async function expectScrollersReachableSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectScrollersReachable(page, label);
  try {
    await expectScrollersReachable(page, label);
  } catch (e) {
    record(String(e).slice(0, 900));
  }
}

/**
 * The 1.4.11 ratchet, soft-wrapped the same way as every other oracle here.
 *
 * This wrapper is the repair of a dead oracle rather than a refactor. In the
 * reference gate every other lab in this fleet was copied from,
 * `expectNoNewNonTextFailures` was called from ONE place: the body of
 * `expectScrollersReachableSoft`, AFTER its `if (!COLLECTING) return …` guard.
 * So in a strict run — which is every run in CI and every run anyone reads as a
 * pass — the guard returned first and `nontext.ts` never executed at all. It is
 * called from `scan()` here, at every driven state.
 */
async function expectNoNewNonTextFailuresSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectNoNewNonTextFailures(page, label);
  try {
    await expectNoNewNonTextFailures(page, label);
  } catch (e) {
    record(String(e).slice(0, 900));
  }
}

async function expectNoHorizontalOverflowSoft(page: Page, label: string): Promise<void> {
  if (!COLLECTING) return expectNoHorizontalOverflow(page, label);
  try {
    await expectNoHorizontalOverflow(page, label);
  } catch (e) {
    record(String(e).slice(0, 900));
  }
}

/**
 * WCAG 1.4.11 and generated content, ratcheted against a per-repo baseline.
 *
 * Neither class has ANY other oracle: axe has no rule for non-text contrast,
 * and the arithmetic text walk cannot reach a control's boundary or a
 * `::before` glyph, because a pseudo-element is not an element and owns no text
 * node.
 *
 * The remaining backlog is real, so this does not block on it — but a check
 * that merely logs is not a gate. So it ratchets instead: anything NOT in the
 * baseline fails, anything in the baseline that got WORSE fails, and anything
 * in the baseline that has been FIXED fails until its entry is deleted. That
 * last rule is what stops the allowlist becoming a permanent exemption.
 */
const nonTextSeen = new Set<string>();

export async function expectNoNewNonTextFailures(page: Page, label: string): Promise<void> {
  const found = await auditNonText(page);
  // Capture mode: emit every finding and assert nothing, so a baseline can be
  // generated by the SAME path that checks it. Opt-in via env, and the run is
  // deliberately left failing at the end by `expectBaselineNotStale` so a
  // capture pass can never be mistaken for a passing gate.
  if (process.env.NT_BASELINE_CAPTURE) {
    for (const f of found) {
      console.log(
        `NTCAP|${f.kind}|${f.selector}|${f.ratio}|${f.required}|${/POSITIONED/.test(f.detail)}`
      );
    }
    return;
  }
  const problems: string[] = [];
  for (const f of found) {
    const key = `${f.kind}|${f.selector}`;
    nonTextSeen.add(key);
    const base = NONTEXT_BASELINE[key];
    if (!base) {
      problems.push(`NEW ${f.ratio}:1 (needs ${f.required}:1) [${f.kind}] ${f.selector} — ${f.detail}`);
    } else if (f.ratio < base.ratio - 0.01) {
      problems.push(`WORSE ${f.selector}: ${f.ratio}:1, baseline recorded ${base.ratio}:1`);
    }
  }
  expect(problems, `new or worsened non-text contrast in state: ${label}`).toEqual([]);
}

/**
 * Fail if a baselined finding never appeared during the whole drive.
 *
 * It has either been fixed — in which case delete the entry, which is the point
 * — or the drive stopped reaching the state that shows it, which is a coverage
 * regression worth knowing about. Call once, after `driveAllStates`.
 */
export function expectBaselineNotStale(): void {
  const unseen = Object.keys(NONTEXT_BASELINE).filter((k) => !nonTextSeen.has(k));
  expect(
    unseen,
    'baselined non-text findings that no longer appear — delete them from nontext-baseline.ts (or restore the drive state that showed them)'
  ).toEqual([]);
}

/**
 * Scan the page as it currently stands.
 *
 * Eight assertions, because axe's `violations` array alone is not a complete
 * oracle:
 *
 *  - reduced-motion end state — see `expectNotBlank`.
 *  - `violations` — the usual WCAG A/AA rule failures, plus four landmark
 *    best-practice rules `withTags` does not run on its own.
 *  - `incomplete` — axe's "could not decide" bucket, which never reaches the
 *    violations array. The one rule id allowed to remain incomplete is
 *    `color-contrast`, and only because the next assertion computes those
 *    ratios arithmetically — which matters here because every verdict chip on
 *    the page is a `color-mix()` axe declines to resolve. Everything else in
 *    that bucket is a real result axe simply could not finish, including
 *    `aria-prohibited-attr`, which is where an `aria-label` on a role-less
 *    element hides — a defect that never reaches the violations array at all,
 *    and a live risk here because five `.tablewrap` divs carry an `aria-label`
 *    made legal only by a `role="region"` that is easy to drop.
 *  - arithmetic contrast — composite-aware WCAG 1.4.3 over every text node,
 *    including the SVG `<text>` that axe's own rule skips entirely.
 *  - non-text contrast and generated content — SC 1.4.11, ratcheted.
 *  - keyboard reachability of scrolling regions — WCAG 2.1.1.
 *  - reflow — WCAG 1.4.10, which axe has no rule for at all.
 *  - list semantics, asked of the live DOM rather than of the source.
 */
export async function scan(page: Page, label: string): Promise<void> {
  await settle(page);
  await expectNotBlank(page, label);
  // TWO axe runs, deliberately, and this is not a style choice.
  //
  // `AxeBuilder.withTags()` and `AxeBuilder.withRules()` both write the same
  // `options.runOnly` field, so the second call SILENTLY REPLACES the first —
  // the axe-core/playwright source says so in as many words on `withRules`
  // ("Cannot be used with AxeBuilder#withTags"). Chained as
  // `.withTags(TAGS).withRules([...4 landmark rules])`, axe therefore runs
  // those FOUR best-practice rules and NOT ONE WCAG RULE, while a green result
  // reads exactly like a full A/AA pass. For scale, `withTags(TAGS)` selects
  // 69 of axe-core 4.12's 105 rule definitions; the chained form executes 4.
  //
  // Running the two sets separately and merging is the only way to have both.
  // The landmark four are still wanted because they are best-practice rather
  // than WCAG-tagged, so `withTags` alone does not reach them, and this page
  // has the shape they catch: a shared sticky `<header role="banner">` above a
  // `<div id="app">` that contains a SECOND `<header>` with an
  // `<aside aria-label>` inside it.
  const wcag = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const landmarks = await new AxeBuilder({ page })
    .withRules([
      'landmark-no-duplicate-banner',
      'landmark-unique',
      'landmark-one-main',
      'landmark-complementary-is-top-level',
    ])
    .analyze();
  const results = {
    violations: [...wcag.violations, ...landmarks.violations],
    incomplete: [...wcag.incomplete, ...landmarks.incomplete],
  };

  const violations = results.violations.map((v) => ({
    state: label,
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
  }));
  softExpect(violations, `axe violations in state: ${label}`, []);

  const unexplainedIncomplete = results.incomplete
    .filter((v) => v.id !== 'color-contrast')
    .map((v) => ({
      state: label,
      id: v.id,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 8),
    }));
  softExpect(unexplainedIncomplete, `axe incomplete results in state: ${label}`, []);

  const contrast = Array.from(new Set(formatContrastFailures(await auditContrast(page))));
  softExpect(contrast, `measured contrast failures in state: ${label}`, []);

  await expectNoNewNonTextFailuresSoft(page, label);
  await expectScrollersReachableSoft(page, label);
  await expectNoHorizontalOverflowSoft(page, label);
  await assertListSemantics(page);
}

// ── The drive ───────────────────────────────────────────────────────────────

/** Open one shut `<details>` by clicking its summary, and assert it opened. */
async function openDetails(page: Page, index: number): Promise<void> {
  const d = page.locator('details').nth(index);
  await d.locator('summary').click();
  await expect(d).toHaveAttribute('open', '');
}

/** Tick or untick a checkbox by id, waiting for the change to land. */
async function setCheck(page: Page, id: string, on: boolean): Promise<void> {
  const box = page.locator(`#${id}`);
  if (on) await box.check();
  else await box.uncheck();
  expect(await box.isChecked(), `#${id} must be ${on ? 'checked' : 'unchecked'}`).toBe(on);
}

/**
 * Drive the lab through the states that render content, scanning each.
 *
 * Six things shape this drive:
 *
 *  - IT STARTS EMPTY, AND THE EMPTY STATE IS SCANNED FIRST. Five of the six
 *    exhibits render nothing until a button is pressed, and the arrival state
 *    is what every reader meets. The gate this replaces ran all six exhibits
 *    and then scanned once, so the empty state was never measured in either
 *    theme.
 *
 *  - EVERY BRANCH OF EVERY MODE FORK. Exhibit 5 has a cheat switch, and BOTH
 *    positions are driven, in that order — the old gate only ever ticked it,
 *    so the honest verdict pair (`chip-neutral` + `chip-ok`, a different fill
 *    on a different border) was never scanned. Exhibit 3 has two worlds and
 *    both are run. Exhibit 4 has four outcome branches and all four are driven,
 *    including the two REFUSAL states — under-two-shares and a duplicate
 *    custodian — which are the only states on the page that render a
 *    `chip-neutral` with an `✗` and no verdict beside it.
 *
 *  - EVERY STEP OF THE STEPPER, AND THE RESET. Exhibit 2's four steps each add
 *    rows to a table and reveal an SVG group; step 4 is the only state that
 *    renders the interpolation bullets and the mixed-epoch chord. `Back` and
 *    `Re-roll the numbers` are both driven, and `Re-roll` is this lab's Reset:
 *    it rebuilds the plot from scratch at the current step.
 *
 *  - THE PREREQUISITE STATE IS SCANNED BEFORE THE UNLOCK. `#mech-prev` ships
 *    disabled and `#mech-next` becomes disabled at the last step; the break-it
 *    grid has ONE column until exhibit 1 turns the epoch, and its mixed-epoch
 *    default selection cannot exist before that. Both "before" renderings are
 *    scanned as well as the "after".
 *
 *  - THE FOCUSED STATE IS A STATE. The skip link is only visible when focused,
 *    and the five `.tablewrap` scrollers are only operable from the keyboard
 *    because they carry `tabindex="0"` — which is worth nothing without a
 *    visible indicator. `expectFocusIndicators` primes `:focus-visible` with a
 *    real Tab before measuring anything.
 *
 *  - NO FIXED TIMEOUTS. Every exhibit is real 2048-bit BigInt arithmetic on the
 *    main thread, and every one has a DOM completion signal: a status line, a
 *    verdict chip's text, a row count, a button returning from `disabled`. The
 *    drive waits on those. (The gate this replaces ended on
 *    `page.waitForTimeout(400)`.)
 */
export async function driveAllStates(page: Page, theme: string): Promise<void> {
  const scanAt = (s: string): Promise<void> => scan(page, `${theme} / ${s}`);

  await scanAt('first paint — six exhibits, five of them empty');

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('Tab');
  await expect(page.locator('a.cl-skip-link')).toBeFocused();
  await scanAt('skip link focused');

  // Priming happens inside `expectFocusIndicators`; every focused-state scan
  // below depends on it, so it runs before them.
  await expectFocusIndicators(page, `${theme} / first paint`);

  // A FOCUSED CONTROL IS A STATE, and it is the one state in which this lab
  // paints an outline at all. Running the full `scan` here is what puts the
  // focus ring under the 1.4.11 oracle: `nontext.ts` measures `outline-color`
  // against the surround whenever an outline is painted, and outside a focused
  // state there is never one to measure.
  await page.locator('#advance-epoch').focus();
  expect(
    await page.evaluate(() => document.activeElement?.matches(':focus-visible')),
    'the primed focus must actually be a :focus-visible one'
  ).toBe(true);
  await scanAt('a primary button focused — the focus ring measured');

  await page.locator('.tablewrap').first().focus();
  await scanAt('a table scroller focused — the focus ring on a tabindex=0 region');

  // ── Exhibit 0: the fine print ───────────────────────────────────────────
  await openDetails(page, 0);
  await scanAt('the cryptographer fine print open');

  // ── Exhibit 1: turn the epoch ───────────────────────────────────────────
  await page.click('#advance-epoch');
  await expect(page.locator('#reshare-compare')).toContainText('Byte-identical', {
    timeout: 180_000,
  });
  // Scoped with `>`: the dealing matrix below is ALSO a `.data-table` inside
  // `#reshare-compare`, so an unscoped descendant selector matches ten rows.
  await expect(page.locator('#reshare-compare > table.data-table tbody tr')).toHaveCount(5);
  await expect(page.locator('#reshare-compare .chip-ok')).toHaveCount(2);
  await scanAt('epoch 2 dealt — same secret, five new shares');

  // The dealing matrix: 5 dealers x 5 sub-shares, inside a `.tablewrap`
  // scroller, and the widest thing on the page at 380px.
  await openDetails(page, 1);
  await expect(page.locator('#reshare-compare details table.data-table tbody tr')).toHaveCount(5);
  await scanAt('the full dealing matrix open');

  // ── Exhibit 2: the stepper, all four steps ──────────────────────────────
  for (const step of [2, 3, 4]) {
    await page.click('#mech-next');
    await expect(page.locator('.mech-caption')).toHaveText(new RegExp(`^Step ${step} of 4 —`));
    await scanAt(`mechanism step ${step} of 4`);
  }
  await expect(page.locator('#mech-next')).toBeDisabled();
  // Step 4 is the only state that renders the three interpolation bullets.
  await expect(page.locator('.mech-table')).toBeVisible();
  await page.click('#mech-prev');
  await expect(page.locator('.mech-caption')).toHaveText(/^Step 3 of 4 —/);
  await scanAt('mechanism stepped back to 3 of 4');

  // Re-roll is this lab's Reset: a fresh instance, rebuilt at the current step.
  const beforeRoll = await page.locator('.mech-table tbody tr').first().innerText();
  await page.click('#mech-reroll');
  await expect(page.locator('.mech-table tbody tr').first()).not.toHaveText(beforeRoll);
  await scanAt('mechanism re-rolled to a fresh instance');

  // ── Exhibit 3: the mobile adversary, both worlds ────────────────────────
  await page.click('#adv-run-off');
  await expect(page.locator('#adv-result-off')).toContainText('BREACH', { timeout: 180_000 });
  await expect(page.locator('#adv-result-off .chip-alarm')).toHaveCount(1);
  await scanAt('adversary without resharing — MATCH and BREACH side by side');

  await page.click('#adv-run-on');
  await expect(page.locator('#adv-result-on')).toContainText('HELD', { timeout: 300_000 });
  await expect(page.locator('#adv-result-on .chip-ok')).toHaveCount(1);
  await scanAt('adversary with resharing — the same plan HELD');

  // ── Exhibit 4: all four break-it outcomes, refusals first ───────────────
  // The grid re-defaulted when exhibit 1 turned the epoch: A@1, B@2, C@2.
  await expect(page.locator('input[id^="pick-"]:checked')).toHaveCount(3);
  // Under two shares: the one state that renders a lone neutral chip.
  for (const id of ['pick-0-1', 'pick-1-2', 'pick-2-2']) await setCheck(page, id, false);
  await expect(page.locator('input[id^="pick-"]:checked')).toHaveCount(0);
  await page.click('#breakit-run');
  await expect(page.locator('#breakit-result')).toContainText('Pick at least two shares');
  await scanAt('break-it refused — fewer than two shares');

  // A duplicate custodian: the same x-coordinate twice, which the field itself
  // refuses. Only reachable now that exhibit 1 gave the grid a second column.
  await setCheck(page, 'pick-0-1', true);
  await setCheck(page, 'pick-0-2', true);
  await page.click('#breakit-run');
  await expect(page.locator('#breakit-result')).toContainText('is selected twice');
  await scanAt('break-it refused — duplicate x-coordinate');

  // Mixed epochs: the headline failure the exhibit exists for.
  await setCheck(page, 'pick-0-2', false);
  await setCheck(page, 'pick-1-2', true);
  await setCheck(page, 'pick-2-2', true);
  await page.click('#breakit-run');
  await expect(page.locator('#breakit-result')).toContainText('REJECT, NO ALARM');
  await scanAt('break-it — mixed epochs interpolate to noise');

  // A same-epoch quorum: the positive control, and the only place `chip-ok`
  // and a MATCH sit together.
  await setCheck(page, 'pick-0-1', false);
  await setCheck(page, 'pick-0-2', true);
  await page.click('#breakit-run');
  await expect(page.locator('#breakit-result')).toContainText('RECOVERED, BY DESIGN');
  await scanAt('break-it — a same-epoch quorum recovers the secret');

  // ── Exhibit 5: both sides of the cheat fork ─────────────────────────────
  await page.click('#cheat-run');
  await expect(page.locator('#cheat-result')).toContainText('All five dealings verified', {
    timeout: 180_000,
  });
  await scanAt('cheat panel — the honest round, never scanned by the old gate');

  await setCheck(page, 'cheat-toggle', true);
  await page.click('#cheat-run');
  await expect(page.locator('#cheat-result')).toContainText('SILENT SECRET CHANGE', {
    timeout: 180_000,
  });
  await expect(page.locator('#cheat-result tr.row-alarm')).toHaveCount(1);
  // `cheat.ts` builds this disclosure with `open: ''`, so it arrives open.
  await expect(page.locator('#cheat-result details[open]')).toHaveCount(1);
  await scanAt('cheat panel — C forges a nonzero constant, the alarm row and the counterfactual');

  // ── Exhibit 6: rotate the committee ─────────────────────────────────────
  await page.click('#membership-run');
  await expect(page.locator('#membership-result')).toContainText('Public key unchanged', {
    timeout: 300_000,
  });
  await expect(page.locator('#membership-result .party-card')).toHaveCount(7);
  await scanAt('committee rotated — 3-of-5 became 4-of-7');

  // Everything on the page is now populated. Open whatever is still shut and
  // measure the fully expanded document — the state the old gate assembled
  // from script and then scanned once.
  const shut = page.locator('details:not([open]) > summary:visible');
  for (let n = await shut.count(); n > 0; n = await shut.count()) await shut.first().click();
  await expect(page.locator('details:not([open]) > summary:visible')).toHaveCount(0);
  await scanAt('the finished page with every disclosure open');

  await expectFocusIndicators(page, `${theme} / fully driven`);
}
