/**
 * Dynamic drill dimensions — browser acceptance.
 *
 * Two of these carry most of the weight. The field-position test is the one
 * that keeps the product honest: choosing a grouping must not move a single
 * particle, and the only convincing way to show that is to read the actual
 * position buffer before and after. The 266-member roster test is the one that
 * keeps the DOCUMENTATION honest: a full-depth cluster can exceed the 150-row
 * cap, so the header has to say so and search has to reach past it.
 */

import { test, expect, type Page } from '@playwright/test';

/** Full book, feed frozen so counts hold still. */
const APP = '/?fx=off&feed=off';

const crumbs = (page: Page) => page.locator('.uv-crumbs li');
const trigger = (page: Page) => page.locator('.uv-dim-trigger');
const dims = (page: Page) => page.locator('.uv-dims button');
const children = (page: Page) => page.locator('.uv-children button');
const heading = (page: Page) => page.locator('.uv-clusters h3');
const rows = (page: Page) => page.locator('.ll-name');
const header = async (page: Page) =>
  ((await page.locator('#leadlist-label').textContent()) ?? '').replace(/\s+/g, ' ').trim();

async function boot(page: Page, url = APP) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
  await page.waitForTimeout(2500);
}

/** Choose what the NEXT level groups by. */
async function groupBy(page: Page, label: string) {
  await trigger(page).click();
  await page.locator('.uv-dims button', { hasText: new RegExp(`^${label}$`) }).first().click();
  await page.waitForTimeout(500);
}

/** Enter a child cluster. */
async function enter(page: Page, label: string) {
  await page.locator('.uv-children button', { hasText: label }).first().click();
  await page.waitForTimeout(700);
}

/**
 * The rendered field, as pixels.
 *
 * Stronger than reading the position buffer, and it needs no production hook:
 * with `?anim=off` (the reduced-motion path) and `?feed=off` the scene is
 * static, so if choosing a grouping moved — or even re-dimmed — a single
 * particle, these bytes would differ.
 */
interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A rectangle of pure field: no chrome, and FIXED for the whole test.
 *
 * `locator('canvas').screenshot()` captures the page region, which includes the
 * drill overlay composited above it — and that overlay legitimately changes
 * when the grouping changes. Worse, recomputing the rectangle per sample lets
 * it MOVE as the overlay grows, which produces a difference that says nothing.
 * So the rectangle is measured once, well below the overlay and clear of the
 * command bar and the bottom-left readout, and reused verbatim.
 */
async function fieldClip(page: Page): Promise<Clip | null> {
  return page.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
    const stage = box('.stage');
    const command = box('.command');
    if (!stage || !command) return null;
    const x = stage.left + stage.width * 0.55;
    const y = stage.top + stage.height * 0.45; // far below any overlay height
    return { x, y, width: stage.right - x - 12, height: command.top - y - 12 };
  });
}

const sampleField = async (page: Page, clip: Clip) =>
  (await page.screenshot({ clip })).toString('base64');

test.describe('the default experience is untouched', () => {
  test('GLOBAL still offers region, and the chain still reads region → state → city → segment', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);

    await expect(heading(page)).toContainText('region');
    await enter(page, 'West');
    await expect(heading(page)).toContainText('state');
    await enter(page, 'Colorado');
    await expect(heading(page)).toContainText('city');
    await enter(page, 'Colorado Springs');
    await expect(heading(page)).toContainText('segment');

    // No dimension labels on a default path — the screen reads as it always did.
    await expect(page.locator('.uv-crumb-dim')).toHaveCount(0);
  });

  test('the picker is closed and adds nothing until it is asked for', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await expect(dims(page)).toHaveCount(0);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('choosing a grouping', () => {
  test('a dynamic path filters the field and the roster', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);

    await groupBy(page, 'Temperature');
    await expect(heading(page)).toContainText('temperature');
    await enter(page, 'Hot');

    // The breadcrumb says what the value IS, because it diverges from the default.
    await expect(page.locator('.uv-crumb-dim').first()).toHaveText('Temperature');
    await expect(
      page.locator('.uv-crumbs [aria-current="location"]'),
      'the accessible name always carries the dimension',
    ).toHaveAttribute('aria-label', 'Temperature: Hot');

    const header0 = await header(page);
    expect(header0).toMatch(/in cluster|showing/);
    expect(await rows(page).count()).toBeGreaterThan(0);
  });

  test('choosing a grouping does NOT navigate or push a step', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    const before = await crumbs(page).count();

    await groupBy(page, 'Campaign');

    expect(await crumbs(page).count(), 'the path must be untouched').toBe(before);
    await expect(heading(page)).toContainText('campaign');
  });

  test('SCORE IS THE ONLY THING THAT MOVES A LEAD', async ({ page }) => {
    // The load-bearing invariant. Choosing a grouping changes which children
    // are offered; it must not move or re-dim a single particle, because it
    // does not change `path`.
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page, '/?fx=off&feed=off&anim=off');
    await page.waitForTimeout(1200);

    const clip = await fieldClip(page);
    expect(clip, 'a field region clear of chrome must exist to sample').not.toBeNull();
    expect(clip!.width).toBeGreaterThan(150);
    expect(clip!.height).toBeGreaterThan(150);

    // Establish that the frozen scene really is static, or the comparison
    // below would prove nothing.
    const baseline = await sampleField(page, clip!);
    await page.waitForTimeout(800);
    expect(
      await sampleField(page, clip!),
      'the frozen scene must be stable before this can mean anything',
    ).toBe(baseline);

    await groupBy(page, 'Campaign');
    await page.waitForTimeout(800);
    expect(
      await sampleField(page, clip!),
      'choosing a grouping must not move a lead',
    ).toBe(baseline);

    await groupBy(page, 'Temperature');
    await page.waitForTimeout(800);
    expect(await sampleField(page, clip!)).toBe(baseline);
  });

  test('a dimension that cannot split is not offered', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await groupBy(page, 'City');
    await enter(page, 'Tampa');

    await trigger(page).click();
    const offered = await dims(page).allTextContents();
    // Every member of Tampa is in Florida and the South, so neither can split.
    expect(offered).not.toContain('State');
    expect(offered).not.toContain('Region');
    expect(offered).not.toContain('City');
    expect(offered.length).toBeGreaterThan(0);
  });

  test('Agent is absent on a fresh book — it has only Unassigned', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await trigger(page).click();
    expect(await dims(page).allTextContents()).not.toContain('Agent');
  });
});

test.describe('the >150 terminal cluster is honest and reachable (D54)', () => {
  test('says "showing 150 of N" and search reaches past the cap', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);

    // The measured-largest shape: Northeast → New York → New York, NY → Cold.
    // The EXACT size is asserted in the unit regression test against the pure
    // seeded book; here it is deliberately not, because the running app applies
    // decay at boot and the temperature split therefore drifts. Asserting a
    // live constant would be asserting the clock.
    await enter(page, 'Northeast');
    await enter(page, 'New York');
    await enter(page, 'New York');
    await groupBy(page, 'Temperature');
    await enter(page, 'Cold');

    expect(await crumbs(page).count()).toBe(5); // GLOBAL + four steps

    const text = await header(page);
    const shown = text.match(/showing (\d+) of ([\d,]+)/);
    expect(shown, `a >150 terminal must say so — got "${text}"`).not.toBeNull();
    expect(Number(shown![1])).toBe(150);
    expect(Number(shown![2]!.replace(/,/g, ''))).toBeGreaterThan(150);

    const visible = await rows(page).allTextContents();
    expect(visible.length).toBe(150);

    // Search is applied BEFORE the cap, which is the whole reachability
    // argument: a precise name surfaces regardless of score rank.
    const target = visible[visible.length - 1]!;
    await page.fill('.leadsearch', target);
    await page.waitForTimeout(400);
    expect(await rows(page).allTextContents()).toContain(target);
    expect(await header(page)).toContain('match');

    await page.getByRole('option', { name: new RegExp(target) }).first().click();
    await page.waitForTimeout(600);
    await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(1);
  });
});

test.describe('composition is unchanged', () => {
  test('command filtering composes with a dynamic path', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    // A cluster under the 150 cap: `capped` deliberately outranks
    // `command filtered` in the header, so a truncated roster would report the
    // truncation instead — correctly, but it would not exercise this.
    await enter(page, 'West');
    await enter(page, 'Colorado');
    await enter(page, 'Colorado Springs');

    await page.getByLabel('Command Apsis').fill('leads in Colorado');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1600);
    expect(await header(page)).toContain('command filtered');
  });

  test('search composes with a dynamic path', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await groupBy(page, 'Campaign');
    await enter(page, (await children(page).first().textContent())!.replace(/\d[\d,]*$/, '').trim());
    await page.fill('.leadsearch', 'zzzznotalead');
    await page.waitForTimeout(400);
    await expect(page.locator('.panel.grow .muted').first()).toContainText('No leads match');
  });

  test('individual focus still engages at depth four of a dynamic path', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    // Dynamic at the first step, then geography — a combination the default
    // chain cannot produce, with enough members to be sure of a lead at depth 4.
    await groupBy(page, 'Segment');
    await enter(page, 'Medicare');
    // Depth 1's positional default is `state` — unchanged by the dynamic first
    // step — so the children here are states, not regions.
    await enter(page, 'New York');
    await enter(page, 'New York');
    // Depth 3's default is `segment`, already used, so resolution steps past it
    // to the first available dimension. Take whatever it offers.
    await children(page).first().click();
    await page.waitForTimeout(900);

    expect(await crumbs(page).count()).toBe(5);
    await page.getByRole('option').first().click();
    await page.waitForTimeout(1800);
    await expect(page.locator('.uv-lead-card')).toHaveCount(1);
  });
});

test.describe('accessibility and responsiveness', () => {
  test('the picker is keyboard operable and returns focus', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);

    await trigger(page).focus();
    await expect(trigger(page)).toHaveAttribute('aria-label', 'Group next by Region');
    await page.keyboard.press('Enter');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');

    // Opening focuses the ACTIVE option.
    await expect(page.locator('.uv-dims button[aria-current="true"]')).toBeFocused();

    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);

    await expect(dims(page)).toHaveCount(0);
    await expect(trigger(page), 'focus must return to the trigger').toBeFocused();
  });

  test('Escape closes the picker first, then clears selection, then backs out', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await enter(page, 'West');
    await page.getByRole('option').first().click();
    await page.waitForTimeout(500);
    await trigger(page).click();
    await expect(dims(page).first()).toBeVisible();

    const depth = await crumbs(page).count();

    await page.keyboard.press('Escape'); // 1. picker
    await page.waitForTimeout(300);
    await expect(dims(page)).toHaveCount(0);
    await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(1);
    expect(await crumbs(page).count()).toBe(depth);

    await page.keyboard.press('Escape'); // 2. selection
    await page.waitForTimeout(300);
    await expect(page.locator('[role=option][aria-selected=true]')).toHaveCount(0);
    expect(await crumbs(page).count()).toBe(depth);

    await page.keyboard.press('Escape'); // 3. drill level
    await page.waitForTimeout(500);
    expect(await crumbs(page).count()).toBe(depth - 1);
  });

  test('no horizontal overflow, and every option is reachable, at every viewport', async ({ page }) => {
    for (const vp of [
      { width: 1280, height: 800 },
      { width: 1600, height: 1000 },
      { width: 2560, height: 1440 },
      { width: 700, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      await boot(page);
      await trigger(page).click();
      await page.waitForTimeout(300);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflow, `horizontal overflow @ ${vp.width}x${vp.height}`).toBe(false);

      // Every dimension option must be hit-testable by a real pointer.
      const count = await dims(page).count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const ok = await dims(page).nth(i).evaluate((el) => {
          el.scrollIntoView({ block: 'nearest' });
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
          const hit = document.elementFromPoint(cx, cy);
          return !!hit && (hit === el || el.contains(hit));
        });
        expect(ok, `dimension ${i} unreachable @ ${vp.width}x${vp.height}`).toBe(true);
      }
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('navigation state does not persist', () => {
  test('a reload returns to GLOBAL with the default grouping', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await boot(page);
    await groupBy(page, 'Temperature');
    await enter(page, 'Hot');
    expect(await crumbs(page).count()).toBe(2);

    await page.reload();
    await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
    await page.waitForTimeout(2000);

    expect(await crumbs(page).count(), 'drill navigation is not persisted').toBe(1);
    await expect(heading(page)).toContainText('region');
  });
});
