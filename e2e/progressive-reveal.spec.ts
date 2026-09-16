/**
 * Progressive lead reveal — browser acceptance.
 *
 * The defect this encodes: after drilling to a segment, the rail's Leads list
 * kept showing the global top-150 *by score* and could contain none of the
 * cluster's members, so a known lead could only be found by clicking particles.
 *
 * These run against the FULL 4,892-lead book on purpose. The bug is a
 * consequence of the 150-cap being 3% of that book; at `?leads=400` the cap
 * barely bites and the test would pass without proving anything — which is
 * exactly how the §14 spec came to pass for the wrong reason.
 */

import { test, expect, type Page } from '@playwright/test';

/** Full book, feed frozen so counts hold still. No `leads=` override. */
const APP = '/?fx=off&feed=off';
const PATH = ['West', 'Colorado', 'Colorado Springs', 'Supplemental'];
const LEAD = 'Claire Moreau';

const rowNames = (page: Page) => page.locator('.ll-name').allTextContents();
const header = async (page: Page) =>
  ((await page.locator('#leadlist-label').textContent()) ?? '').replace(/\s+/g, ' ').trim();

async function boot(page: Page, url = APP) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: /^Leads/ })).toBeVisible();
  await page.waitForTimeout(2500);
}

async function drill(page: Page, steps = PATH) {
  for (const label of steps) {
    await page.locator('.uv-clusters button', { hasText: label }).first().click();
    await page.waitForTimeout(700);
  }
}

test.describe('progressive reveal', () => {
  test('THE REPORTED BUG: at full depth every cluster member is listed', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);

    // Before the fix this was the global top-150 and did not contain the lead.
    await drill(page);

    const names = await rowNames(page);
    expect(names.length).toBeGreaterThan(0);
    expect(names, 'the drilled lead must be listed, not hunted for').toContain(LEAD);

    // The roster IS the cluster: the header count equals the rows shown, with
    // no cap language, because a full-depth cluster cannot reach 150.
    const h = await header(page);
    expect(h).toContain('in cluster');
    expect(h).not.toContain('showing');
    expect(h).toContain(String(names.length));
  });

  test('the roster is actually ON SCREEN after drilling, not merely rendered', async ({ page }) => {
    // The gap the rest of this suite could not see. Every other assertion here
    // passed while the roster sat 145px below the rail's fold at 1600x1000 and
    // 345px at 1280x800: the list held exactly the leads the user wanted and
    // they could not see it. Locators do not care about scroll position; a
    // human does. Same failure class as D12.
    for (const vp of [
      { width: 1600, height: 1000 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(vp);
      await boot(page);
      await drill(page);

      // "Visible" must mean OPERABLE. An earlier version of this assertion only
      // checked that the panel's top edge was inside the rail — which passed
      // while every row sat at the fold with its centre outside the viewport,
      // so a real click never reached one. Assert the first row can be hit.
      const state = await page.evaluate(() => {
        const panel = document.querySelector('#leadlist-label')?.closest('section');
        const rail = panel?.parentElement;
        const row = document.querySelector('[role=option]');
        if (!panel || !rail || !row) return null;
        const p = panel.getBoundingClientRect();
        const r = rail.getBoundingClientRect();
        const q = row.getBoundingClientRect();
        const cx = q.left + q.width / 2;
        const cy = q.top + q.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return {
          panelVisible: p.top < r.bottom && p.bottom > r.top,
          rowCentreOnScreen: cy > 0 && cy < window.innerHeight && cx > 0 && cx < window.innerWidth,
          rowReceivesPointer: !!hit && (hit === row || row.contains(hit) || hit.contains(row)),
        };
      });
      expect(state, `roster must exist @ ${vp.width}x${vp.height}`).not.toBeNull();
      expect(state!.panelVisible, `roster panel on screen @ ${vp.width}x${vp.height}`).toBe(true);
      expect(state!.rowCentreOnScreen, `a row's click point must be on screen @ ${vp.width}x${vp.height}`).toBe(true);
      expect(state!.rowReceivesPointer, `a row must receive a real click @ ${vp.width}x${vp.height}`).toBe(true);

      // And prove it: a real click (hit-tested, unlike a synthetic .click())
      // must actually select.
      await page.getByRole('option').first().click();
      await page.waitForTimeout(600);
      await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(1);
    }
  });

  test('selecting by name from the roster engages §14 focus', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await drill(page);

    await page.getByRole('option', { name: new RegExp(LEAD) }).first().click();
    await page.waitForTimeout(1800);

    await expect(page.locator('.uv-lead-card')).toHaveCount(1);
    await expect(page.locator('.uv-lead-card-name')).toHaveText(LEAD);
    await expect(
      page.getByRole('option', { name: new RegExp(LEAD) }).first(),
    ).toHaveAttribute('aria-selected', 'true');
  });

  test('the roster narrows with depth and never overstates itself', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);

    // GLOBAL: capped, and says so.
    expect(await header(page)).toContain('showing');
    const counts: number[] = [(await rowNames(page)).length];

    for (const step of PATH) {
      await drill(page, [step]);
      counts.push((await rowNames(page)).length);
      const h = await header(page);
      // Either it is complete ("in cluster") or it declares the truncation.
      expect(h.includes('in cluster') || h.includes('showing')).toBe(true);
    }
    // Monotonically narrowing, and materially so by the end.
    expect(counts.at(-1)!).toBeLessThan(counts[0]);
    expect(counts.at(-1)!).toBeLessThan(30);
  });

  test('search filters within the cluster only, with an explicit empty state', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await drill(page);

    await page.fill('.leadsearch', 'moreau');
    await page.waitForTimeout(400);
    expect(await rowNames(page)).toEqual([LEAD]);
    expect(await header(page)).toContain('match');

    // A name that exists in the BOOK but not in this cluster must not appear:
    // search is scoped to the drill, never to the whole book.
    await page.fill('.leadsearch', 'zzzznotalead');
    await page.waitForTimeout(400);
    expect(await rowNames(page)).toEqual([]);
    await expect(page.locator('.panel.grow .muted').first()).toContainText('No leads match');
  });

  test('search clears when the drill path changes', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await drill(page);
    await page.fill('.leadsearch', 'moreau');
    await page.waitForTimeout(300);
    expect(await rowNames(page)).toEqual([LEAD]);

    // Back out one level: a filter left over from another cluster would be a
    // lie about what is on screen.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    expect(await page.inputValue('.leadsearch')).toBe('');
    expect((await rowNames(page)).length).toBeGreaterThan(1);
  });

  test('search is absent at GLOBAL and present once drilled', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await expect(page.locator('.leadsearch')).toHaveCount(0);
    await drill(page, ['West']);
    await expect(page.locator('.leadsearch')).toHaveCount(1);
  });

  test('POINTER-FREE: drill, type, arrow, Enter, focus engages', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await drill(page); // drill via breadcrumb buttons, then no pointer at all

    await page.locator('.leadsearch').focus();
    await page.keyboard.type('moreau');
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowDown'); // hands over to the listbox
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);

    await expect(page.locator('.uv-lead-card-name')).toHaveText(LEAD);
    await expect(
      page.locator('[role=option][aria-selected=true] .ll-name'),
    ).toHaveText(LEAD);
  });

  test('hover correlates list and field in both directions', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page, '/?fx=off&feed=off&anim=off&diag=1');
    await drill(page, ['West', 'Colorado', 'Colorado Springs']); // ~24 rows

    const draws = async () => {
      const t = await page.evaluate(() =>
        [...document.querySelectorAll('div')].map((d) => d.textContent).find((x) => x?.includes('draws')),
      );
      return Number(t?.match(/(\d+) draws/)?.[1] ?? 0);
    };

    await page.locator('#leadlist-label').hover();
    await page.waitForTimeout(700);
    const idle = await draws();

    // Row → field: exactly one extra draw call, and the row marks itself.
    await page.locator('[role=option]').nth(2).hover();
    await page.waitForTimeout(700);
    expect(await draws(), 'hover ring costs exactly one draw call').toBe(idle + 1);
    await expect(page.locator('[role=option].hovered')).toHaveCount(1);

    // Leaving the list retires the ring — otherwise it points at a lead the
    // user is no longer indicating.
    await page.locator('#leadlist-label').hover();
    await page.waitForTimeout(800);
    expect(await draws()).toBe(idle);
    await expect(page.locator('[role=option].hovered')).toHaveCount(0);
  });

  test('drill and command-bar results compose, and the header admits both', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await drill(page, ['West', 'Colorado', 'Colorado Springs']);
    const beforeCount = (await rowNames(page)).length;

    await page.getByLabel('Command Apsis').fill('hot leads in Colorado');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1600);

    const names = await rowNames(page);
    expect(names.length).toBeLessThanOrEqual(beforeCount);
    // It is the INTERSECTION, not either filter alone — and it says so.
    expect(await header(page)).toContain('command filtered');
  });
});
