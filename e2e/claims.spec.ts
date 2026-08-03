import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Functional regression gate for the Reshare Circle demo.
 *
 * The a11y spec proves the page is reachable and scannable; this one proves the
 * page is *right*. Nothing here is compared against a string the test invented:
 * every expected number is derived from what the page itself rendered, so a
 * broken computation cannot be papered over by a matching hardcoded constant.
 * What that buys, exhibit by exhibit:
 *
 *   1. Turn the epoch — the headline verdict ("byte-identical secret, unmoved
 *      public key, every share new") is re-derived from the two 64-hex
 *      reconstructions the page printed, and the chip must agree with that
 *      independent comparison rather than merely exist. The "5/5 · 25/25"
 *      counters are checked to be the SUM of the dealing matrix's own per-cell
 *      ticks, and the new-share column is checked against the live committee
 *      cards and the panel-4 grid, so the three views cannot drift apart.
 *   2. The whole trick — GF(1019) arithmetic re-run in the test: every epoch-2
 *      cell must equal its epoch-1 cell plus the three deltas printed above it,
 *      each delta row must equal its own stated slope, and the step-4
 *      interpolation bullets are recomputed by Lagrange from the table's own
 *      numbers (2y₁ − y₂ and 3y₂ − 2y₃ over GF(1019)). Re-rolling must move the
 *      numbers and keep all of it true — no stale row surviving the re-roll.
 *   3. The mobile adversary — every regime the README claims is playable:
 *      patient cross-epoch theft (MATCH + BREACH), the same plan defeated by
 *      resharing (NO MATCH + HELD), the honest edge where three thefts inside
 *      one epoch beat resharing, below-threshold loot, a re-robbed custodian
 *      that buys the attacker nothing, and the empty plan that is refused.
 *   4. Break it yourself — the failure paths the README promises: under two
 *      shares, a duplicate custodian (division by zero), mixed epochs, and a
 *      below-threshold quorum; plus the positive control, where the panel's own
 *      real Lagrange run must reproduce the very secret panel 1 displayed.
 *   5. The dealer who lies — C's sub-shares still pass Feldman while only the
 *      D₀ = 1 check fails, and the "if nobody checked" counterfactual is
 *      verified by BigInt subtraction of the two printed 64-hex values: the
 *      difference must be exactly the constant C smuggled in.
 *   6. Rotate the committee — same secret across a threshold change, verified
 *      against panel 5's independent print of that same secret, with 3 of the
 *      new 7 shares confirmed to be below the new bar.
 *
 * Stale state is treated as a defect throughout: a verdict must never outlive
 * the selection, epoch or mode it was computed for.
 */

const SECRET_HEX = /^[0-9a-f]{64}$/;
const SMALL_Q = 1019n;

/** dom.ts truncHex: `0x` + first 10 + `…` + last 6 of the bare hex digits. */
function truncHex(value: bigint): string {
  const h = value.toString(16);
  return h.length <= 18 ? `0x${h}` : `0x${h.slice(0, 10)}…${h.slice(-6)}`;
}

async function text(scope: Page | Locator, selector: string): Promise<string> {
  return ((await scope.locator(selector).first().innerText()) ?? '').trim();
}

/** The panel (section) that owns the given control id. */
function panelOf(page: Page, controlId: string): Locator {
  return page.locator(`section.panel:has(#${controlId})`);
}

/** The `role="status"` line of the panel owning `controlId`. */
async function statusOf(page: Page, controlId: string): Promise<string> {
  return text(panelOf(page, controlId), '.seal-status');
}

/** Click a button that kicks off real 2048-bit work and wait for it to finish. */
async function runAndSettle(page: Page, buttonId: string): Promise<void> {
  const button = page.locator(`#${buttonId}`);
  await button.click();
  await expect(button).toBeEnabled({ timeout: 180000 });
}

/** Advance panel 1 by one epoch and wait for the compare block to render. */
async function advanceEpoch(page: Page): Promise<void> {
  const before = await page.locator('#reshare-compare').innerText();
  await page.locator('#advance-epoch').click();
  await expect
    .poll(async () => (await page.locator('#reshare-compare').innerText()) !== before, {
      timeout: 180000,
    })
    .toBe(true);
  await expect(page.locator('#advance-epoch')).toBeEnabled({ timeout: 180000 });
}

/** The 64-hex payloads of a result block's labelled hex rows, in order. */
async function hexRows(page: Page, containerId: string): Promise<string[]> {
  return page.locator(`#${containerId} .hexrow .hexblock`).allInnerTexts();
}

/** Tick exactly the given checkbox ids inside a panel, untick everything else. */
async function setChecks(panel: Locator, ids: string[]): Promise<void> {
  const boxes = panel.locator('input[type=checkbox]');
  for (let i = 0; i < (await boxes.count()); i += 1) {
    const box = boxes.nth(i);
    const id = await box.getAttribute('id');
    if (ids.includes(id ?? '')) await box.check();
    else await box.uncheck();
  }
}

/** Lagrange at x = 0 through two small-field points, over GF(1019). */
function interpolateTwo(x1: bigint, y1: bigint, x2: bigint, y2: bigint): bigint {
  const inv = (a: bigint): bigint => {
    let r = 1n;
    let e = SMALL_Q - 2n;
    let b = ((a % SMALL_Q) + SMALL_Q) % SMALL_Q;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % SMALL_Q;
      b = (b * b) % SMALL_Q;
      e >>= 1n;
    }
    return r;
  };
  const term = (xi: bigint, yi: bigint, xj: bigint) =>
    (((yi * (((-xj % SMALL_Q) + SMALL_Q) % SMALL_Q)) % SMALL_Q) * inv(((xi - xj) % SMALL_Q + SMALL_Q) % SMALL_Q)) % SMALL_Q;
  return (term(x1, y1, x2) + term(x2, y2, x1)) % SMALL_Q;
}

/** The mechanism table as [rowHeader, seatZero, A, B, C] strings. */
async function mechRows(page: Page): Promise<string[][]> {
  return page
    .locator('.mech-table tbody tr')
    .evaluateAll((rows) =>
      rows.map((r) => Array.from(r.children).map((c) => (c as HTMLElement).innerText.trim())),
    );
}

// Uncaught page exceptions fail the test that provoked them. Reset per test; a
// worker only ever runs one test at a time, so this stays test-scoped.
let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto('.');
  // The initial 3-of-5 deal is real crypto; the panels mount only once it lands.
  await expect(page.locator('#advance-epoch')).toBeVisible({ timeout: 120000 });
});

test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Exhibit 1 — turn the epoch
// ---------------------------------------------------------------------------

test('the epoch turn keeps the secret and Y that the page itself reconstructed', async ({ page }) => {
  await expect(panelOf(page, 'advance-epoch').locator('.kv-item').first()).toContainText(
    'Epoch 1',
  );
  await advanceEpoch(page);

  const [recPrev, recNext, yBefore, yAfter] = await hexRows(page, 'reshare-compare');

  // The audit view's two reconstructions are full 256-bit values, so the test
  // can do the comparison the page claims to have done — independently.
  expect(recPrev).toMatch(SECRET_HEX);
  expect(recNext).toMatch(SECRET_HEX);
  const secretsEqual = recPrev === recNext;
  const keysEqual = yBefore === yAfter;
  expect(secretsEqual).toBe(true);
  expect(keysEqual).toBe(true);

  // ...and the chips must agree with that comparison, not merely be present.
  const chips = page.locator('#reshare-compare .side-card .chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveClass(/chip-ok/);
  await expect(chips.nth(0)).toContainText('Byte-identical');
  await expect(chips.nth(1)).toHaveClass(/chip-ok/);
  await expect(chips.nth(1)).toContainText('Identical (compared in full)');

  // Every share really is a new value, per the page's own before/after columns.
  const rows = await page
    .locator('#reshare-compare table.data-table')
    .first()
    .locator('tbody tr')
    .evaluateAll((rs) => rs.map((r) => Array.from(r.children).map((c) => (c as HTMLElement).innerText.trim())));
  expect(rows).toHaveLength(5);
  for (const [custodian, oldShare, newShare, changed] of rows) {
    expect(custodian).toMatch(/^[ABCDE]$/);
    expect(newShare).not.toBe(oldShare);
    expect(changed).toBe('yes — completely new value');
  }

  // The live committee cards show the epoch-2 column, not a stale epoch-1 one.
  const cards = await panelOf(page, 'advance-epoch').locator('.party-share').allInnerTexts();
  expect(cards.map((c) => c.trim())).toEqual(rows.map((r) => r[2]));
  await expect(panelOf(page, 'advance-epoch').locator('.kv-item').first()).toContainText('Epoch 2');

  // ...and so does panel 4's grid: the two panels read one committee.
  const gridEpoch2 = await panelOf(page, 'breakit-run')
    .locator('tbody tr')
    .evaluateAll((rs) =>
      rs.map((r) => (r.children[2].querySelector('code') as HTMLElement).innerText.trim()),
    );
  expect(gridEpoch2).toEqual(rows.map((r) => r[2]));
});

test('the round-verified counters are the sum of the dealing matrix ticks', async ({ page }) => {
  await advanceEpoch(page);

  const lede = await text(page, '#reshare-compare .panel-lede');
  const claimed = [...lede.matchAll(/(\d+)\/(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  expect(claimed).toHaveLength(3); // zero checks, sub-share checks, new-share checks

  await page.locator('#reshare-compare details summary').click();
  const matrix = page.locator('#reshare-compare details tbody tr');
  await expect(matrix).toHaveCount(5);

  const cells = await matrix.evaluateAll((rs) =>
    rs.map((r) => Array.from(r.children).map((c) => (c as HTMLElement).innerText.trim())),
  );

  // Counter 1: "N/5 dealings committed to a zero constant term" must equal the
  // number of rows whose own zero-check cell passed — and D₀ must be the
  // identity in every one of them, which is what makes that pass honest.
  const zeroPasses = cells.filter((c) => c[2] === '✓ pass').length;
  expect(zeroPasses).toBe(claimed[0][0]);
  expect(claimed[0]).toEqual([5, 5]);
  for (const row of cells) expect(row[1]).toBe('1 (identity)');

  // Counter 2: "M/25 Feldman sub-share checks" must equal the ticks actually
  // printed in the 5 x 5 sub-share block — parts summing to the whole.
  const subCells = cells.flatMap((row) => row.slice(3));
  expect(subCells).toHaveLength(25);
  expect(subCells.filter((c) => c.endsWith('✓')).length).toBe(claimed[1][0]);
  expect(claimed[1]).toEqual([25, 25]);
  expect(claimed[2]).toEqual([5, 5]);
});

test('a second epoch turn compares against the first, with no epoch-1 residue', async ({ page }) => {
  await advanceEpoch(page);
  const firstNew = await page
    .locator('#reshare-compare table.data-table')
    .first()
    .locator('tbody tr')
    .evaluateAll((rs) => rs.map((r) => (r.children[2] as HTMLElement).innerText.trim()));

  await advanceEpoch(page);
  const headers = await page
    .locator('#reshare-compare table.data-table')
    .first()
    .locator('thead th')
    .allInnerTexts();
  expect(headers.map((h) => h.trim())).toEqual([
    'Custodian',
    'Epoch 2 share',
    'Epoch 3 share',
    'Changed?',
  ]);

  // Round two's "before" column is round one's "after" column — the history is
  // chained, not re-dealt.
  const second = await page
    .locator('#reshare-compare table.data-table')
    .first()
    .locator('tbody tr')
    .evaluateAll((rs) => rs.map((r) => Array.from(r.children).map((c) => (c as HTMLElement).innerText.trim())));
  expect(second.map((r) => r[1])).toEqual(firstNew);
  for (const row of second) expect(row[2]).not.toBe(row[1]);

  // The secret survived two turns, still byte-identical.
  const [recPrev, recNext] = await hexRows(page, 'reshare-compare');
  expect(recNext).toBe(recPrev);
});

// ---------------------------------------------------------------------------
// Exhibit 2 — the whole trick (GF(1019))
// ---------------------------------------------------------------------------

test('the small-field table is arithmetically self-consistent at every step', async ({ page }) => {
  await expect(page.locator('#mech-prev')).toBeDisabled();
  await expect(page.locator('#mech-next')).toBeEnabled();
  await expect(page.locator('.mech-caption')).toContainText('Step 1 of 4');
  expect(await mechRows(page)).toHaveLength(1); // nothing from later steps leaks in

  for (let i = 0; i < 3; i += 1) await page.locator('#mech-next').click();
  await expect(page.locator('.mech-caption')).toContainText('Step 4 of 4');
  await expect(page.locator('#mech-next')).toBeDisabled();
  await expect(page.locator('#mech-prev')).toBeEnabled();

  const rows = await mechRows(page);
  expect(rows).toHaveLength(5); // f, three deltas, the sum

  // Row 1 states its own polynomial: f(x) = secret + slope*x. Check the cells.
  const fMatch = /f\(x\) = (\d+) \+ (\d+)·x/.exec(rows[0][0])!;
  const secret = BigInt(fMatch[1]);
  const slope = BigInt(fMatch[2]);
  expect(rows[0][1]).toBe(String(secret)); // x = 0 seat IS the secret
  const fAt = [1n, 2n, 3n].map((x) => (secret + slope * x) % SMALL_Q);
  expect(rows[0].slice(2)).toEqual(fAt.map(String));

  // Each delta row states its slope and is pinned to zero at x = 0.
  const deltas = rows.slice(1, 4).map((row) => {
    const k = BigInt(/= (\d+)·x/.exec(row[0])![1]);
    expect(row[0]).toContain('no constant term');
    expect(row[1]).toBe('0');
    expect(row.slice(2)).toEqual([1n, 2n, 3n].map((x) => `+${(k * x) % SMALL_Q}`));
    return k;
  });
  expect(deltas).toHaveLength(3);

  // The sum row is exactly the parts above it summing to the whole, and the
  // seat at x = 0 has not moved by so much as one.
  const sumSlope = deltas.reduce((a, b) => a + b, 0n);
  expect(rows[4][1].replace(/\s*\*$/, '')).toBe(String(secret));
  expect(rows[4].slice(2)).toEqual(
    [1n, 2n, 3n].map((x) => String((secret + (slope + sumSlope) * x) % SMALL_Q)),
  );

  // The step-4 bullets are real interpolations: recompute each from the table's
  // own numbers rather than trusting the printed answer.
  const newAt = (x: bigint) => (secret + (slope + sumSlope) * x) % SMALL_Q;
  const bullets = await panelOf(page, 'mech-next').locator('.scope-list li').allInnerTexts();
  expect(bullets).toHaveLength(3);
  const stated = bullets.map((b) => BigInt(/interpolate to (\d+)/.exec(b)![1]));
  expect(stated[0]).toBe(interpolateTwo(1n, newAt(1n), 2n, newAt(2n)));
  expect(stated[1]).toBe(interpolateTwo(2n, fAt[1], 3n, fAt[2]));
  expect(stated[2]).toBe(interpolateTwo(1n, fAt[0], 2n, newAt(2n)));

  // Both same-epoch quorums land on the secret; the mixed pair does not.
  expect(stated[0]).toBe(secret);
  expect(stated[1]).toBe(secret);
  expect(stated[2]).not.toBe(secret);
  expect(bullets[2]).toContain(`not ${secret}`);

  // The plot's accessible description carries the same numbers as the table
  // (the README's promise that plot and table agree).
  const label = (await page.locator('.mech-plot svg').getAttribute('aria-label')) ?? '';
  expect(label).toContain(`heights ${fAt[0]}, ${fAt[1]} and ${fAt[2]}`);
  expect(label).toContain(`epoch-2 points ${newAt(1n)}, ${newAt(2n)} and ${newAt(3n)}`);
  expect(label).toContain(`x equals zero stays ${secret}`);
  expect(label).toContain(`lands at ${stated[2]} instead of ${secret}`);
});

test('re-rolling replaces every number and leaves nothing from the old instance', async ({ page }) => {
  for (let i = 0; i < 3; i += 1) await page.locator('#mech-next').click();
  const before = await mechRows(page);
  const labelBefore = await page.locator('.mech-plot svg').getAttribute('aria-label');

  await page.locator('#mech-reroll').click();
  await expect
    .poll(async () => JSON.stringify(await mechRows(page)), { timeout: 30000 })
    .not.toBe(JSON.stringify(before));

  const rows = await mechRows(page);
  expect(rows).toHaveLength(5); // the re-roll keeps the learner on step 4
  expect(await page.locator('.mech-plot svg').getAttribute('aria-label')).not.toBe(labelBefore);

  // Same invariants on the new instance: sum row = f row + the three deltas,
  // and the bullets are recomputed, not carried over from the old numbers.
  const fMatch = /f\(x\) = (\d+) \+ (\d+)·x/.exec(rows[0][0])!;
  const secret = BigInt(fMatch[1]);
  const slope = BigInt(fMatch[2]);
  const deltas = rows.slice(1, 4).map((row) => BigInt(/= (\d+)·x/.exec(row[0])![1]));
  const sumSlope = deltas.reduce((a, b) => a + b, 0n);
  const newAt = (x: bigint) => (secret + (slope + sumSlope) * x) % SMALL_Q;
  expect(rows[4].slice(2)).toEqual([1n, 2n, 3n].map((x) => String(newAt(x))));

  const bullets = await panelOf(page, 'mech-next').locator('.scope-list li').allInnerTexts();
  const stated = bullets.map((b) => BigInt(/interpolate to (\d+)/.exec(b)![1]));
  expect(stated[0]).toBe(secret);
  expect(stated[2]).toBe(interpolateTwo(1n, (secret + slope) % SMALL_Q, 2n, newAt(2n)));
  expect(stated[2]).not.toBe(secret);
});

// ---------------------------------------------------------------------------
// Exhibit 3 — the mobile adversary
// ---------------------------------------------------------------------------

test('the default campaign breaks the threshold without resharing and dies with it', async ({ page }) => {
  const panel = panelOf(page, 'adv-run-off');
  const planned = await panel.locator('input:checked').evaluateAll((bs) =>
    bs.map((b) => `${b.getAttribute('data-party')}:${b.getAttribute('data-epoch')}`),
  );
  expect(planned).toEqual(['0:1', '1:3', '2:5']); // A@1, B@3, C@5

  await runAndSettle(page, 'adv-run-off');
  const off = page.locator('#adv-result-off');

  // The run restates the plan it was given, so the result names its own inputs.
  await expect(off).toContainText('Thefts: A@1 · B@3 · C@5');
  await expect(off.locator('.timeline li')).toHaveCount(5);
  await expect(off.locator('.loot-list li')).toHaveCount(planned.length);
  await expect(off.locator('h4').first()).toContainText('loot (3 shares, t = 3)');

  // MATCH and BREACH are separate indicators — the whole point of the exhibit.
  const offChips = off.locator('.verdict-pair .chip');
  await expect(offChips).toHaveCount(2);
  await expect(offChips.nth(0)).toHaveClass(/chip-neutral/);
  await expect(offChips.nth(0)).toContainText('g^v = Y — MATCH');
  await expect(offChips.nth(1)).toHaveClass(/chip-alarm/);
  await expect(offChips.nth(1)).toContainText('BREACH');
  expect(await statusOf(page, 'adv-run-off')).toContain('the attacker holds the private scalar');

  // No verdict leaks across cards: the other world has not been run.
  await expect(page.locator('#adv-result-on')).toContainText('Not run yet.');

  await runAndSettle(page, 'adv-run-on');
  const on = page.locator('#adv-result-on');
  await expect(on).toContainText('Thefts: A@1 · B@3 · C@5');
  const onChips = on.locator('.verdict-pair .chip');
  await expect(onChips.nth(0)).toContainText('g^v ≠ Y — NO MATCH');
  await expect(onChips.nth(1)).toHaveClass(/chip-ok/);
  await expect(onChips.nth(1)).toContainText('HELD — the thefts span epochs');
  await expect(on).toContainText('The loot spans epochs 1, 3, 5');
  expect(await statusOf(page, 'adv-run-off')).toContain('interpolates to noise');

  // Same loot size, opposite outcome: resharing is the only variable.
  await expect(on.locator('.loot-list li')).toHaveCount(planned.length);
  await expect(off.locator('.verdict-pair .chip').nth(1)).toContainText('BREACH');
});

test('three thefts inside one epoch beat resharing, and the demo says so', async ({ page }) => {
  const panel = panelOf(page, 'adv-run-off');
  await setChecks(panel, ['steal-0-2', 'steal-1-2', 'steal-2-2']);
  await runAndSettle(page, 'adv-run-on');

  const on = page.locator('#adv-result-on');
  await expect(on).toContainText('Thefts: A@2 · B@2 · C@2');
  const chips = on.locator('.verdict-pair .chip');
  await expect(chips.nth(0)).toContainText('g^v = Y — MATCH');
  await expect(chips.nth(1)).toHaveClass(/chip-alarm/);
  // The verdict names the cause: which epoch the quorum landed in.
  await expect(chips.nth(1)).toContainText('BREACH — 3 thefts landed inside epoch 2');
  await expect(on).toContainText('It cannot beat a quorum assembled within one epoch');
});

test('below-threshold and repeat-custodian campaigns are HELD, with the reason named', async ({ page }) => {
  const panel = panelOf(page, 'adv-run-off');

  // Two thefts: plain Shamir already wins, and the verdict counts them.
  await setChecks(panel, ['steal-0-1', 'steal-1-3']);
  await runAndSettle(page, 'adv-run-off');
  const off = page.locator('#adv-result-off');
  await expect(off.locator('.loot-list li')).toHaveCount(2);
  await expect(off.locator('.verdict-pair .chip').nth(0)).toContainText('NO MATCH');
  await expect(off.locator('.verdict-pair .chip').nth(1)).toHaveClass(/chip-ok/);
  await expect(off.locator('.verdict-pair .chip').nth(1)).toContainText(
    'HELD — only 2 shares: below the threshold of 3',
  );

  // The same custodian robbed five times is still one usable point: five pieces
  // of loot, one interpolated share, and the note says why (duplicate x).
  await setChecks(panel, ['steal-0-1', 'steal-0-2', 'steal-0-3', 'steal-0-4', 'steal-0-5']);
  await runAndSettle(page, 'adv-run-off');
  await expect(off.locator('.loot-list li')).toHaveCount(5);
  await expect(off).toContainText('The attacker plays its best move');
  await expect(off).toContainText('a custodian can only be fed in once');
  await expect(off.locator('.verdict-pair .chip').nth(1)).toContainText(
    'HELD — only 1 share: below the threshold of 3',
  );
  // Five identical copies really were identical — the shares never moved.
  const loot = await off.locator('.loot-list li code').allInnerTexts();
  expect(new Set(loot.map((l) => l.trim())).size).toBe(1);
});

test('an empty theft plan is refused and leaves both worlds unrun', async ({ page }) => {
  await setChecks(panelOf(page, 'adv-run-off'), []);
  await page.locator('#adv-run-off').click();
  await expect
    .poll(() => statusOf(page, 'adv-run-off'), { timeout: 30000 })
    .toBe('Plan at least one theft in the grid above.');
  await expect(page.locator('#adv-result-off')).toContainText('Not run yet.');
  await expect(page.locator('#adv-result-on')).toContainText('Not run yet.');
});

// ---------------------------------------------------------------------------
// Exhibit 4 — break it yourself
// ---------------------------------------------------------------------------

test('a same-epoch quorum reproduces exactly the secret panel 1 printed', async ({ page }) => {
  await advanceEpoch(page);
  const [reconstructed] = await hexRows(page, 'reshare-compare');
  expect(reconstructed).toMatch(SECRET_HEX);

  const panel = panelOf(page, 'breakit-run');
  await setChecks(panel, ['pick-0-2', 'pick-1-2', 'pick-2-2']);
  await runAndSettle(page, 'breakit-run');

  const result = page.locator('#breakit-result');
  // The panel prints a truncated value; the expected form is derived from the
  // full 64-hex secret panel 1 displayed, so this is a real equality check on
  // an independent Lagrange run over three different shares.
  const expected = truncHex(BigInt(`0x${reconstructed}`));
  await expect(result).toContainText(`Interpolation output: ${expected}`);

  const chips = result.locator('.verdict-pair .chip');
  await expect(chips.nth(0)).toContainText('g^v = Y — MATCH');
  await expect(chips.nth(1)).toHaveClass(/chip-ok/);
  await expect(chips.nth(1)).toContainText(
    'RECOVERED, BY DESIGN — 3 shares from epoch 2 meet the 3-of-5 threshold',
  );
});

test('every break-it failure path is reached and names its cause', async ({ page }) => {
  await advanceEpoch(page);
  const panel = panelOf(page, 'breakit-run');
  const result = page.locator('#breakit-result');

  // One share: refused before any interpolation happens.
  await setChecks(panel, ['pick-0-1']);
  await runAndSettle(page, 'breakit-run');
  await expect(result).toContainText('Pick at least two shares — one point determines nothing.');
  await expect(result.locator('.verdict-pair')).toHaveCount(0);
  expect(await statusOf(page, 'breakit-run')).toBe('Nothing to interpolate yet.');

  // Same custodian twice: the one mixture the field itself refuses.
  await setChecks(panel, ['pick-0-1', 'pick-0-2', 'pick-1-2']);
  await runAndSettle(page, 'breakit-run');
  await expect(result).toContainText('Interpolation refused before it starts: A is selected twice.');
  await expect(result).toContainText('Lagrange divides by (xᵢ − xⱼ) — zero here');
  expect(await statusOf(page, 'breakit-run')).toBe('Refused: duplicate x-coordinate.');

  // Mixed epochs: rejected by algebra, and the verdict names the epochs mixed.
  await setChecks(panel, ['pick-0-1', 'pick-1-2', 'pick-2-2']);
  await runAndSettle(page, 'breakit-run');
  let chips = result.locator('.verdict-pair .chip');
  await expect(chips.nth(0)).toContainText('g^v ≠ Y — NO MATCH');
  await expect(chips.nth(1)).toContainText('REJECT, NO ALARM');
  await expect(result).toContainText('You mixed epochs 1 and 2.');

  // Below threshold, one epoch: interpolation answers, confidently and wrongly.
  await setChecks(panel, ['pick-0-2', 'pick-1-2']);
  await runAndSettle(page, 'breakit-run');
  chips = result.locator('.verdict-pair .chip');
  await expect(chips.nth(0)).toContainText('g^v ≠ Y — NO MATCH');
  await expect(chips.nth(1)).toContainText('HELD — 2 shares are below the threshold of 3');
  await expect(result).toContainText('Below the threshold, interpolation still answers');
});

test('a break-it verdict never outlives the selection it was computed for', async ({ page }) => {
  await advanceEpoch(page);
  const panel = panelOf(page, 'breakit-run');
  const result = page.locator('#breakit-result');

  await setChecks(panel, ['pick-0-2', 'pick-1-2', 'pick-2-2']);
  await runAndSettle(page, 'breakit-run');
  await expect(result).toContainText('RECOVERED, BY DESIGN');

  // Ticking one more box changes what "the selected shares" means, so the
  // MATCH verdict must be retracted rather than left hanging over new inputs.
  await panel.locator('#pick-3-1').check();
  await expect(result).toBeEmpty();
  expect(await statusOf(page, 'breakit-run')).toBe(
    'Selection changed — reconstruct again for a verdict about the shares now ticked.',
  );
  await expect(page.locator('#breakit-run')).toBeEnabled();

  // Regression: turning the epoch in panel 1 re-defaults this grid to a
  // mixed-epoch selection. A standing "g^v = Y — MATCH / RECOVERED BY DESIGN"
  // used to survive that and sit above ticks that reconstruct to noise.
  await setChecks(panel, ['pick-0-2', 'pick-1-2', 'pick-2-2']);
  await runAndSettle(page, 'breakit-run');
  await expect(result).toContainText('g^v = Y — MATCH');

  await advanceEpoch(page);
  const ticked = await panel.locator('input:checked').evaluateAll((bs) =>
    bs.map((b) => `${b.getAttribute('data-party')}:${b.getAttribute('data-epoch')}`),
  );
  expect(new Set(ticked.map((t) => t.split(':')[1])).size).toBeGreaterThan(1); // mixed
  await expect(result).toBeEmpty();

  // And the panel is still alive: the new selection produces its own verdict.
  await runAndSettle(page, 'breakit-run');
  await expect(result.locator('.verdict-pair .chip').nth(0)).toContainText('NO MATCH');
  await expect(result.locator('.verdict-pair .chip').nth(1)).toContainText('REJECT, NO ALARM');
});

// ---------------------------------------------------------------------------
// Exhibit 5 — the dealer who lies
// ---------------------------------------------------------------------------

test('an honest round passes all five dealings with no alarm anywhere', async ({ page }) => {
  await runAndSettle(page, 'cheat-run');
  const result = page.locator('#cheat-result');

  const rows = await result
    .locator('tbody tr')
    .evaluateAll((rs) =>
      rs.map((r) => [r.className, ...Array.from(r.children).map((c) => (c as HTMLElement).innerText.trim())]),
    );
  expect(rows).toHaveLength(5);
  for (const [cls, , d0, zero, subs] of rows) {
    expect(cls).not.toContain('row-alarm');
    expect(d0).toBe('1 (identity)');
    expect(zero).toBe('✓ pass');
    expect(subs).toBe('5/5 ✓');
  }

  await expect(result.locator('.chip-alarm')).toHaveCount(0);
  await expect(result.locator('.verdict-pair .chip').nth(1)).toContainText('HELD — an honest round');
  await expect(result).not.toContainText('SILENT SECRET CHANGE');
  expect(await statusOf(page, 'cheat-run')).toBe('All dealings verified clean.');
});

test('a nonzero constant term is caught only by D0 = 1, and its cost is computed', async ({ page }) => {
  await page.locator('#cheat-toggle').check();
  await runAndSettle(page, 'cheat-run');
  const result = page.locator('#cheat-result');

  const rows = await result
    .locator('tbody tr')
    .evaluateAll((rs) =>
      rs.map((r) => [r.className, ...Array.from(r.children).map((c) => (c as HTMLElement).innerText.trim())]),
    );
  const alarmed = rows.filter((r) => r[0].includes('row-alarm'));
  expect(alarmed).toHaveLength(1);
  expect(alarmed[0][1]).toBe('C'); // exactly the party the checkbox names

  for (const row of rows) {
    // The lie is invisible to the per-sub-share Feldman check for EVERY dealer,
    // cheater included — that is the README's point about why D₀ exists.
    expect(row[4]).toBe('5/5 ✓');
    if (row[1] === 'C') {
      expect(row[2]).not.toBe('1 (identity)');
      expect(row[3]).toBe('✗ FAIL — nonzero constant term');
    } else {
      expect(row[2]).toBe('1 (identity)');
      expect(row[3]).toBe('✓ pass');
    }
  }

  // The protocol path held: C was dropped and the round still preserved the key.
  const chips = result.locator('.verdict-pair .chip');
  await expect(chips.nth(0)).toContainText('commitment check FAILED');
  await expect(chips.nth(1)).toHaveClass(/chip-ok/);
  await expect(chips.nth(1)).toContainText('HELD — C’s dealing was rejected');
  await expect(result).toContainText('MATCH ✓');
  await expect(result).toContainText('byte-identical ✓');

  // The counterfactual is arithmetic, not narration: the two 64-hex values the
  // page printed must differ by exactly the constant it says C smuggled in.
  const [secretHex, forgedHex] = await hexRows(page, 'cheat-result');
  expect(secretHex).toMatch(SECRET_HEX);
  expect(forgedHex).toMatch(SECRET_HEX);
  const shift = BigInt(`0x${forgedHex}`) - BigInt(`0x${secretHex}`);
  const stated = BigInt(
    /Difference: exactly \+\s*(\d+)/.exec(await text(result, '.expert .note'))![1],
  );
  expect(shift).toBe(stated);
  expect(shift).toBe(7n);
  await expect(result.locator('.chip-alarm')).toContainText('SILENT SECRET CHANGE');
});

test('turning the cheat off retracts the forged-world block', async ({ page }) => {
  await page.locator('#cheat-toggle').check();
  await runAndSettle(page, 'cheat-run');
  await expect(page.locator('#cheat-result')).toContainText('SILENT SECRET CHANGE');

  await page.locator('#cheat-toggle').uncheck();
  await runAndSettle(page, 'cheat-run');
  // No ALARM chip and no counterfactual survive into the honest round.
  await expect(page.locator('#cheat-result')).not.toContainText('SILENT SECRET CHANGE');
  await expect(page.locator('#cheat-result .chip-alarm')).toHaveCount(0);
  await expect(page.locator('#cheat-result .expert')).toHaveCount(0);
  await expect(page.locator('#cheat-result tbody tr.row-alarm')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Exhibit 6 — rotate the committee
// ---------------------------------------------------------------------------

test('redistribution moves the same secret to a 4-of-7 committee and raises the bar', async ({ page }) => {
  await runAndSettle(page, 'membership-run');
  const result = page.locator('#membership-result');

  // Counters: 3 dealers, and 3 x 7 = 21 sub-share checks — parts and whole.
  const lede = await text(result, '.panel-lede');
  const counts = [...lede.matchAll(/(\d+)\/(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  expect(counts).toEqual([[3, 3], [21, 21]]);
  const cards = await result.locator('.party-card').allInnerTexts();
  expect(counts[1][1]).toBe(counts[0][1] * cards.length);

  // Seven new custodians at x = 1..7.
  expect(cards).toHaveLength(7);
  cards.forEach((card, j) => expect(card).toContain(`P${j + 1} (x = ${j + 1})`));

  // Same secret, verified against the page's own two prints of it.
  const [recNew, oldSecret] = await hexRows(page, 'membership-result');
  expect(recNew).toMatch(SECRET_HEX);
  expect(recNew).toBe(oldSecret);
  const chips = result.locator('.chip');
  await expect(chips.nth(0)).toHaveClass(/chip-ok/);
  await expect(chips.nth(0)).toContainText('Byte-identical');
  await expect(chips.nth(1)).toHaveClass(/chip-ok/);
  await expect(chips.nth(1)).toContainText('Public key unchanged');

  // The new threshold is enforced: three shares no longer reach it.
  await expect(chips.nth(2)).toContainText('g^v ≠ Y — NO MATCH: three shares are no longer a quorum');
  expect(await statusOf(page, 'membership-run')).toContain('threshold now 4');
});

test('the same 256-bit secret is the one every exhibit reports', async ({ page }) => {
  // Panel 1's audit reconstruction, panel 5's print of the committee's secret
  // and panel 6's 4-of-7 reconstruction are three independent derivations that
  // must land on one value; a drift in any of them is a broken claim.
  await advanceEpoch(page);
  const [fromEpochs] = await hexRows(page, 'reshare-compare');

  await runAndSettle(page, 'membership-run');
  const [fromNewCommittee, oldSecret] = await hexRows(page, 'membership-result');

  await page.locator('#cheat-toggle').check();
  await runAndSettle(page, 'cheat-run');
  const [cheatSecret] = await hexRows(page, 'cheat-result');

  expect(fromEpochs).toMatch(SECRET_HEX);
  expect(new Set([fromEpochs, fromNewCommittee, oldSecret, cheatSecret]).size).toBe(1);
});
