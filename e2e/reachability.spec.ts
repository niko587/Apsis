/**
 * Reachability — the check D12 needed and did not have.
 *
 * The rail was `overflow: hidden` around more content than fits, so five of
 * nine panels sat below an unscrollable fold: present in the DOM, correctly
 * laid out, and impossible to see or click. TypeScript passed. Eighty unit
 * tests passed. Lint passed. The build passed. The §22 responsive audit passed
 * too, because it asked whether anything overflowed *horizontally*.
 *
 * The lesson recorded in SELF-CRITIQUE.md is that **rendered is not
 * reachable**, and nothing in a jsdom-shaped test can tell the difference. This
 * file is that lesson made executable.
 *
 * WHY WHEEL EVENTS AND NOT `scrollIntoView()`:
 * an `overflow: hidden` element is still *programmatically* scrollable — you
 * can set its `scrollTop`, and both `scrollIntoView()` and Playwright's own
 * auto-scroll-before-click will happily move it. A suite built on either would
 * have passed cheerfully while the rail was broken, which is the precise
 * failure this file exists to prevent. So reachability here is established the
 * only way a user can establish it: by sending real wheel events at the rail
 * and seeing whether anything moves.
 *
 * NEVER measure FPS here. This browser software-rasterizes (~4 FPS for one
 * triangle); GPU claims need the owner's hardware (AI_DEVELOPMENT_PROTOCOL).
 */

import { test, expect, type Locator, type Page } from '@playwright/test';

/** Small book, no post-processing: this suite tests layout, not throughput. */
const APP = '/?leads=400&fx=off';

/**
 * The nine rail panels, by their `h2` accessible name.
 *
 * Anchored regexes rather than exact strings because several headings carry a
 * live count in a `<span>` ("AI Agents 3 working"), which lands in the
 * accessible name. `/^Lead$/` must stay exact — unanchored it would also match
 * "Lead Temperature" and "Leads 4,892 total", and a test that matches three
 * panels when it means one is not testing what it says.
 */
const PANELS: ReadonlyArray<{ label: string; heading: RegExp }> = [
  { label: 'Apsis State', heading: /^Apsis State$/ },
  { label: 'Pipeline', heading: /^Pipeline$/ },
  // "Lead" empty, "Lead unpin" once a lead is pinned — the `unpin` button lives
  // inside the h2 and lands in its accessible name. Must not widen to /^Lead\b/,
  // which would also swallow "Lead Temperature".
  { label: 'Lead detail', heading: /^Lead( unpin)?$/ },
  { label: 'Appointment centre', heading: /^Qualified Booked Appointments/ },
  { label: 'Agent roster', heading: /^AI Agents/ },
  { label: 'Temperature legend', heading: /^Lead Temperature$/ },
  { label: 'Leads list', heading: /^Leads\b/ },
  { label: 'Model Orchestrator', heading: /^Model Orchestrator/ },
  { label: 'Activity feed', heading: /^Live Activity$/ },
];

const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1600x1000', width: 1600, height: 1000 }, // the size D12 was found at
  { name: '2560x1440', width: 2560, height: 1440 },
];

interface Geometry {
  inViewport: boolean;
  receivesPointer: boolean;
  hit: string | null;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Geometry + hit test in one round trip.
 *
 * `receivesPointer` is the half that matters: a box can be inside the viewport
 * and still be covered by an overlay, and `elementFromPoint` is the only thing
 * that knows. Ancestor and descendant both count as a hit — targeting an `h2`
 * legitimately returns the `h2`, a `<span>` inside it, or the panel itself.
 */
async function geometryOf(target: Locator): Promise<Geometry> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const inViewport =
      r.width > 0 &&
      r.height > 0 &&
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= window.innerHeight &&
      r.right <= window.innerWidth;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const receivesPointer =
      !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    return {
      inViewport,
      receivesPointer,
      hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className || '')}`.trim() : null,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  });
}

const railScrollTop = (rail: Locator) => rail.evaluate((el) => el.scrollTop);

/**
 * Scroll `target` into view the way a user would: point at the rail, turn the
 * wheel. Returns the geometry reached, plus how many wheel ticks it took.
 *
 * Gives up early when a tick moves `scrollTop` by nothing — that is either the
 * end of the scroll range or a container that cannot scroll at all, and both
 * mean more wheeling is pointless.
 */
async function wheelIntoView(
  page: Page,
  rail: Locator,
  target: Locator,
): Promise<{ geometry: Geometry; ticks: number }> {
  const railBox = await rail.boundingBox();
  expect(railBox, 'the rail itself must have a layout box').not.toBeNull();
  await page.mouse.move(
    railBox!.x + railBox!.width / 2,
    railBox!.y + railBox!.height / 2,
  );

  let geometry = await geometryOf(target);
  for (let ticks = 1; ticks <= 40; ticks++) {
    if (geometry.inViewport && geometry.receivesPointer) return { geometry, ticks: ticks - 1 };

    const before = await railScrollTop(rail);
    // Direction is derived from where the target actually is, so this works
    // walking back up the rail as well as down it.
    await page.mouse.wheel(0, geometry.top < railBox!.y ? -260 : 260);
    await page.waitForTimeout(50);
    const after = await railScrollTop(rail);

    geometry = await geometryOf(target);
    if (before === after) return { geometry, ticks };
  }
  return { geometry, ticks: 40 };
}

async function bootApp(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto(APP);
  // The rail renders from the seeded book, so waiting on a panel that carries a
  // live count means waiting for real state rather than an arbitrary sleep.
  await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
}

for (const vp of VIEWPORTS) {
  test.describe(`reachability @ ${vp.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await bootApp(page, vp.width, vp.height);
    });

    test('every rail panel is reachable by wheel and receives a click', async ({ page }) => {
      const rail = page.locator('.rail');
      await expect(rail).toBeVisible();

      const unreachable: string[] = [];

      for (const { label, heading } of PANELS) {
        const panel = page
          .locator('.rail section.panel')
          .filter({ has: page.getByRole('heading', { level: 2, name: heading }) });
        // Catches the other failure mode: a panel that stopped rendering at all.
        await expect(panel, `${label}: exactly one panel should carry this heading`).toHaveCount(1);

        const h2 = panel.getByRole('heading', { level: 2 });
        const { geometry, ticks } = await wheelIntoView(page, rail, h2);

        if (!geometry.inViewport || !geometry.receivesPointer) {
          unreachable.push(
            `${label}: inViewport=${geometry.inViewport} receivesPointer=${geometry.receivesPointer} ` +
              `top=${Math.round(geometry.top)} bottom=${Math.round(geometry.bottom)} ` +
              `viewportH=${vp.height} hitAt centre=${geometry.hit} afterWheelTicks=${ticks}`,
          );
          continue;
        }

        // Geometry says it is there and unoccluded; a real click proves it.
        // Headings are inert, so this asserts deliverability without side effects.
        await h2.click({ timeout: 5_000 });
      }

      // Aggregate-then-assert (D18): one failure should not hide the other four.
      expect(unreachable, `unreachable panels at ${vp.name}:\n${unreachable.join('\n')}`).toEqual([]);
    });

    test('the rail is user-scrollable whenever its content overflows (D12)', async ({ page }) => {
      const rail = page.locator('.rail');
      const state = await rail.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY,
      }));

      if (state.scrollHeight <= state.clientHeight + 1) {
        // Tall viewport, everything fits — nothing to scroll and nothing to prove.
        test.skip(true, `rail does not overflow at ${vp.name}`);
        return;
      }

      expect(
        ['auto', 'scroll'],
        `rail overflows (${state.scrollHeight}px of content in ${state.clientHeight}px) ` +
          `but computed overflow-y is "${state.overflowY}" — content below the fold is unreachable`,
      ).toContain(state.overflowY);

      // The computed style is the diagnosis; this is the symptom. Both, because
      // a future layout could break scrolling without touching `overflow-y`.
      const box = (await rail.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(80);
      expect(await railScrollTop(rail), 'wheeling over an overflowing rail must scroll it').toBeGreaterThan(0);
    });
  });
}

test.describe('interaction reachability', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page, 1600, 1000);
  });

  /**
   * D12's sharpest symptom: the Leads list was not merely awkward, it was
   * unclickable. A panel you can see but cannot operate is still broken, so the
   * assertion is that the click *did something* — selection landed in the store
   * and surfaced in the detail panel.
   */
  test('a lead row in the rail can be scrolled to, clicked, and selects', async ({ page }) => {
    const rail = page.locator('.rail');
    const list = page
      .locator('.rail section.panel')
      .filter({ has: page.getByRole('heading', { level: 2, name: /^Leads\b/ }) });

    const { geometry } = await wheelIntoView(page, rail, list.getByRole('heading', { level: 2 }));
    expect(geometry.inViewport && geometry.receivesPointer, 'Leads panel must be reachable').toBe(true);

    const row = list.getByRole('option').first();
    await expect(row).toBeVisible();
    const name = (await row.locator('.ll-name').textContent())?.trim() ?? '';
    expect(name.length, 'a lead row should carry a name').toBeGreaterThan(0);

    await row.click({ timeout: 5_000 });

    // Two different things, both required: the list agrees it is selected, and
    // the click actually travelled into the store and back out somewhere else.
    await expect(row).toHaveAttribute('aria-selected', 'true');
    const detail = page
      .locator('.rail section.panel')
      .filter({ has: page.getByRole('heading', { level: 2, name: /^Lead( unpin)?$/ }) });
    await expect(
      detail.locator('.lead-name'),
      'the detail panel must show the lead that was clicked',
    ).toHaveText(name);
  });

  /** §13 calls the command bar the primary human interface; it must never need a scroll. */
  test('the command bar is reachable without scrolling and accepts input', async ({ page }) => {
    const input = page.getByLabel('Command Apsis');
    const geometry = await geometryOf(input);
    expect(geometry.inViewport, 'command bar must be on screen at load').toBe(true);
    expect(geometry.receivesPointer, `command bar is occluded by ${geometry.hit}`).toBe(true);

    await input.click();
    await input.fill('hot leads in Texas');
    await expect(input).toHaveValue('hot leads in Texas');
  });
});
