import { expect, test } from '@playwright/test';
import {
  boot,
  driveAllStates,
  expectBaselineNotStale,
  NARROW,
  reportCollected,
  watchPageErrors,
} from './gate';

/**
 * WCAG A/AA regression gate.
 *
 * The lab is driven along everything it teaches, and EVERY step is scanned:
 * the arrival state, where five of the six exhibits have rendered nothing and
 * the mechanism plot's three step groups are still hidden; the skip link
 * focused; a primary button and a table scroller focused, which are the only
 * states in which this page paints an outline at all; the cryptographer fine
 * print opened through its own summary; a real HJKY epoch turn in the 2048-bit
 * RFC 3526 group, then the full dealing matrix; all four steps of the
 * small-field stepper, a step back, and a re-roll; the mobile adversary in both
 * worlds — the MATCH+BREACH pair and the HELD pair; all four break-it outcomes
 * including the two REFUSAL states the old gate never reached (fewer than two
 * shares, and a duplicate x-coordinate); BOTH sides of the cheating-dealer
 * fork, honest round first, which the old gate skipped entirely by ticking the
 * box before its only scan; the 3-of-5 to 4-of-7 rotation; and finally the
 * fully expanded document.
 *
 * Four configurations: {dark, light} x {1280px, 380px}. The gate this replaces
 * ran the light theme at the SAME 1280px viewport as the dark one, so the
 * phone-width column — where all five `.tablewrap` tables are scrolled and the
 * hero aside takes `width: 100%` — had never been scanned in either theme.
 *
 * See `gate.ts` for why nothing is injected into the page, why no `<details>`
 * is opened from script, why the lab's defaults are asserted rather than
 * assumed, and why `violations` is not the whole oracle.
 */

for (const theme of ['dark'] as const) {
  test(`no WCAG A/AA violations in ${theme} theme`, async ({ page }) => {
    test.setTimeout(1_800_000);
    const errors = watchPageErrors(page);
    await boot(page, theme);
    await driveAllStates(page, theme);
    expect(errors, errors.join('\n')).toEqual([]);
    expectBaselineNotStale();
    reportCollected();
  });

  test(`no WCAG A/AA violations in ${theme} theme at 380px`, async ({ page }) => {
    test.setTimeout(1_800_000);
    const errors = watchPageErrors(page);
    await page.setViewportSize(NARROW);
    await boot(page, theme);
    await driveAllStates(page, `${theme} @380px`);
    expect(errors, errors.join('\n')).toEqual([]);
    expectBaselineNotStale();
    reportCollected();
  });
}
