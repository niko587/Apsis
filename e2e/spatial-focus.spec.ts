/**
 * §14 spatial individual transition — browser acceptance.
 *
 * Drives the real journey: GLOBAL → West → Colorado → Colorado Springs →
 * Supplemental → Claire Moreau, using the deterministic seeded book with the
 * feed frozen (`?feed=off`) so the same lead tops the Leads list forever.
 * The path is derived from the seed (0x5f3a21, 400 leads) exactly like the
 * pinned values in dimensions.test.ts — if the seed ever changes, this fails
 * loudly rather than drifting.
 *
 * What the browser must prove that unit tests cannot: the card exists only at
 * individual focus, is aria-hidden, stays inside the stage and off the command
 * bar at every layout, tracks the lead, unwinds on Escape, and appears intact
 * under reduced motion.
 */

import { test, expect, type Page } from '@playwright/test';

const APP = '/?leads=400&fx=off&feed=off';
/**
 * The full 4,892-lead book. Needed only by the retarget test: at `?leads=400`
 * this cluster has exactly one member, so there is no second lead to retarget
 * onto. Both books put the same lead at the top of it.
 */
const FULL_BOOK = '/?fx=off&feed=off';
/** Deterministic top-of-list lead for seed 0x5f3a21, at 400 leads and at 4,892. */
const LEAD = 'Claire Moreau';
/** Second member of the same cluster on the full book (score 39, ranked below LEAD). */
const OTHER_IN_CLUSTER = 'Marcus Reyes';
const PATH = ['West', 'Colorado', 'Colorado Springs', 'Supplemental'];

async function drillToSegment(page: Page, settleMs = 1500) {
  await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
  await page.waitForTimeout(settleMs);
  for (const label of PATH) {
    await page.locator('.uv-clusters button', { hasText: label }).first().click();
    await page.waitForTimeout(700); // camera glide between levels
  }
}

async function focusLead(page: Page) {
  await page.getByRole('option', { name: new RegExp(LEAD) }).first().click();
  // Move attention out of the listbox: Escape semantics inside the listbox
  // belong to the listbox (it clears selection itself). The field journey the
  // contract describes has attention on the stage.
  await page.locator('[role=option]', { hasText: LEAD }).first().evaluate((el) => {
    (el.closest('[role=listbox]') as HTMLElement | null)?.blur();
  });
  await page.waitForTimeout(1800); // camera commit + card fade-in
}

test.describe('§14 spatial individual focus', () => {
  test('the journey resolves into an in-scene card that matches the rail', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(APP);
    await drillToSegment(page);

    // No card before selection — tier 2 requires a selected lead.
    await expect(page.locator('.uv-lead-card')).toHaveCount(0);

    await focusLead(page);

    const card = page.locator('.uv-lead-card');
    await expect(card).toHaveCount(1);
    // Spatial confirmation, not a second accessibility surface.
    await expect(card).toHaveAttribute('aria-hidden', 'true');

    // Selection fidelity: card, rail and listbox all name the same lead.
    await expect(card).toContainText(LEAD);
    await expect(card).toContainText('Booked');
    await expect(card).toContainText('100');
    const rail = page.locator('.rail section.panel').filter({
      has: page.getByRole('heading', { level: 2, name: /^Lead( unpin)?$/ }),
    });
    await expect(rail.locator('.lead-name')).toHaveText(LEAD);
    await expect(page.getByRole('option', { name: new RegExp(LEAD) }).first()).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  const VIEWPORTS = [
    { name: '1280x800', width: 1280, height: 800 },
    { name: '1600x1000', width: 1600, height: 1000 },
    { name: '2560x1440', width: 2560, height: 1440 },
    { name: '700x900 stacked', width: 700, height: 900 },
  ];

  for (const vp of VIEWPORTS) {
    test(`card stays inside the stage and off the command bar @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(APP);
      await drillToSegment(page);
      await focusLead(page);

      const card = await page.locator('.uv-lead-card').boundingBox();
      const stage = await page.locator('.stage').boundingBox();
      const command = await page.locator('.command').boundingBox();
      expect(card, 'card must exist at focus').not.toBeNull();

      // Inside the stage box (D12's lesson: clipped is broken).
      expect(card!.x).toBeGreaterThanOrEqual(stage!.x - 1);
      expect(card!.y).toBeGreaterThanOrEqual(stage!.y - 1);
      expect(card!.x + card!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
      expect(card!.y + card!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);

      // Never on the primary interface.
      const overlapsCommand =
        card!.y + card!.height > command!.y &&
        card!.x < command!.x + command!.width &&
        card!.x + card!.width > command!.x;
      expect(overlapsCommand, 'card must not overlap the command bar').toBe(false);
    });
  }

  test('Escape unwinds: card first, then one drill level', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(APP);
    await drillToSegment(page);
    await focusLead(page);
    await expect(page.locator('.uv-lead-card')).toHaveCount(1);
    const crumbsAtFocus = await page.locator('.uv-crumbs li').count();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    await expect(page.locator('.uv-lead-card'), 'first Escape clears focus').toHaveCount(0);
    expect(await page.locator('.uv-crumbs li').count(), 'drill preserved').toBe(crumbsAtFocus);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    expect(await page.locator('.uv-crumbs li').count(), 'second Escape pops a level').toBe(
      crumbsAtFocus - 1,
    );
  });

  /**
   * WHAT THIS TEST USED TO SAY, AND WHY IT HAD TO CHANGE.
   *
   * It clicked `getByRole('option').nth(1)` and asserted the card DISAPPEARED,
   * on the reasoning that "the next list row is outside this cluster, so focus
   * dissolves to tier 1". That was true when the roster was the global top-150
   * by score. Progressive lead reveal made the roster drill-aware, so every row
   * in it is now a member of the drilled cluster by construction — there is no
   * "next row outside the cluster" left to click. At `?leads=400` this cluster
   * holds exactly ONE lead, so `nth(1)` names nothing at all and the test hung.
   *
   * The property the title claims — drill survives, subject changes — is still
   * real and is now worth MORE than it was: the correct outcome is that focus
   * RETARGETS rather than dissolves. So the test asks for that, and picks its
   * second lead by name. A positional `nth()` would be asserting about roster
   * ordering, which is not what this test is for.
   *
   * Runs on the full book because that is where this cluster has more than one
   * member (4: Claire Moreau, Marcus Reyes, Felix Bergman, Daniel Rivera).
   *
   * The dissolve-on-non-membership rule itself is not lost — it is tier 2 of the
   * contract's state model and `spatialFocus.test.ts` pins it directly.
   */
  test('selecting a different lead in the cluster retargets without unwinding', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(FULL_BOOK);
    await drillToSegment(page, 2500);
    await focusLead(page);
    await expect(page.locator('.uv-lead-card-name')).toHaveText(LEAD);

    const crumbs = await page.locator('.uv-crumbs li').count();
    await page.getByRole('option', { name: new RegExp(OTHER_IN_CLUSTER) }).first().click();
    await page.waitForTimeout(1800);

    expect(
      await page.locator('.uv-crumbs li').count(),
      'a retarget must not unwind the drill',
    ).toBe(crumbs);
    // Focus moves to the new subject rather than dissolving: still exactly one
    // card, now naming the other lead.
    await expect(page.locator('.uv-lead-card')).toHaveCount(1);
    await expect(page.locator('.uv-lead-card-name')).toHaveText(OTHER_IN_CLUSTER);
    await expect(
      page.getByRole('option', { name: new RegExp(OTHER_IN_CLUSTER) }).first(),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('option', { name: new RegExp(LEAD) }).first(),
      'the previous subject must let go',
    ).toHaveAttribute('aria-selected', 'false');
  });

  test('reduced motion: the card still appears, without animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(APP);
    await drillToSegment(page);
    await focusLead(page);

    const card = page.locator('.uv-lead-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(LEAD);
    const animation = await card.evaluate((el) => getComputedStyle(el).animationName);
    expect(animation).toBe('none');
  });

  test('selection is announced exactly once (no double-announce from the card)', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(APP);
    await drillToSegment(page);
    await focusLead(page);

    const statuses = page.locator('[role=status]');
    let announcing = 0;
    for (let i = 0; i < (await statuses.count()); i++) {
      const text = (await statuses.nth(i).textContent()) ?? '';
      if (text.includes(LEAD)) announcing++;
    }
    expect(announcing, 'exactly one live region announces the selection').toBe(1);
  });
});
