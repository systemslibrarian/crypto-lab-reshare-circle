import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Drive every exhibit against the real crypto so all dynamic result regions
 * (compare tables, verdict chips — including the ALARM states — the dealing
 * matrix and the break-it grid) exist when axe scans. The 2048-bit group is
 * genuinely slow, hence the generous expect timeouts.
 */
async function prepare(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important}`,
  });

  // Panel 1: advance an epoch (also gives the break-it grid a second column).
  await expect(page.locator('#advance-epoch')).toBeVisible();
  await page.locator('#advance-epoch').click();
  await expect(page.locator('#reshare-compare')).toContainText('Byte-identical');

  // Panel 2: step the mechanism to its final state (all rows + checks shown).
  await page.locator('#mech-next').click();
  await page.locator('#mech-next').click();
  await page.locator('#mech-next').click();

  // Panel 3: both adversary runs — the MATCH+BREACH pair and the HELD pair.
  await page.locator('#adv-run-off').click();
  await expect(page.locator('#adv-result-off')).toContainText('BREACH');
  await page.locator('#adv-run-on').click();
  await expect(page.locator('#adv-result-on')).toContainText('HELD');

  // Panel 4: default selection is mixed-epoch once epoch 2 exists.
  await page.locator('#breakit-run').click();
  await expect(page.locator('#breakit-result')).toContainText('REJECT, NO ALARM');

  // Panel 5: cheating dealer, including the forged-but-accepted ALARM block.
  await page.locator('#cheat-toggle').check();
  await page.locator('#cheat-run').click();
  await expect(page.locator('#cheat-result')).toContainText('SILENT SECRET CHANGE');

  // Panel 6: membership change.
  await page.locator('#membership-run').click();
  await expect(page.locator('#membership-result')).toContainText('Public key unchanged');

  await page.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => ((d as HTMLDetailsElement).open = true));
  });
  await page.waitForTimeout(400);
}

async function scan(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
    })),
  ).toEqual([]);
}

test('no WCAG A/AA violations — dark theme', async ({ page }) => {
  await page.goto('.');
  await prepare(page);
  await scan(page);
});

test('no WCAG A/AA violations — light theme', async ({ page }) => {
  await page.goto('.');
  await page.locator('#cl-theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await prepare(page);
  await scan(page);
});
