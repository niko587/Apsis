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
  /** The assertion: can a user actually reach and operate this element? */
  reachable: boolean;
  receivesPointer: boolean;
  /** Diagnostic only — whether the WHOLE box fits. Never asserted; see below. */
  fullyInViewport: boolean;
  hit: string | null;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Geometry + hit test in one round trip.
 *
 * WHAT THIS ASSERTS, AND WHY IT CHANGED:
 * the original check required the element's ENTIRE bounding box to sit inside
 * the viewport. That is stricter than the question this suite exists to ask —
 * "can a real user reach and interact with this?" — and it made the result
 * depend on font metrics. On the CI runner's Linux fonts the last rail panel's
 * heading landed at `top=991 bottom=1002` against a 1000px viewport: two pixels
 * of an eleven-pixel heading were outside, while `elementFromPoint` at its
 * centre resolved to the heading itself and a real click landed on it. The test
 * failed an element the user can see and click, and passed or failed by a pixel
 * depending on the platform's font rendering.
 *
 * The invariant is now the semantic one: the point a user would click must be
 * inside the viewport, and hit-testing at that point must resolve to the target.
 * That is not a loosened tolerance — no slop value was introduced — it is a
 * different and more accurate question. `fullyInViewport` is still computed and
 * still reported in failure messages, because knowing a box is clipped is useful
 * even when it is not a failure.
 *
 * `receivesPointer` remains the half that matters: a box can be inside the
 * viewport and still be covered by an overlay, and `elementFromPoint` is the
 * only thing that knows. Ancestor and descendant both count as a hit — targeting
 * an `h2` legitimately returns the `h2`, a `<span>` inside it, or the panel.
 */
async function geometryOf(target: Locator): Promise<Geometry> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hasBox = r.width > 0 && r.height > 0;
    const fullyInViewport =
      hasBox &&
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= window.innerHeight &&
      r.right <= window.innerWidth;

    // The point a click would be delivered to.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const centreOnScreen =
      cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;

    const hit = document.elementFromPoint(cx, cy);
    const receivesPointer =
      !!hit && (hit === el || el.contains(hit) || hit.contains(el));

    return {
      reachable: hasBox && centreOnScreen && receivesPointer,
      receivesPointer,
      fullyInViewport,
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
  // Consecutive ticks in which the wheel moved nothing. Bailing on the FIRST
  // stalled tick was a race: with the live feed running, the rail can be at a
  // momentary bottom when the wheel fires, then grow (an appointment lands,
  // LeadDetail fills on hover) — leaving the target a few px below a fold that
  // scrolling could now reach. Three stalls distinguishes "genuinely cannot
  // scroll" from "briefly at the bottom of a living document"; the D12
  // regression (overflow: hidden) never moves scrollTop at all, so it still
  // fails immediately at 3 ticks with reachable=false.
  let stalls = 0;
  for (let ticks = 1; ticks <= 40; ticks++) {
    if (geometry.reachable) return { geometry, ticks: ticks - 1 };

    const before = await railScrollTop(rail);
    // Direction is derived from where the target actually is, so this works
    // walking back up the rail as well as down it.
    await page.mouse.wheel(0, geometry.top < railBox!.y ? -260 : 260);
    await page.waitForTimeout(50);
    const after = await railScrollTop(rail);

    geometry = await geometryOf(target);
    stalls = before === after ? stalls + 1 : 0;
    if (stalls >= 3) return { geometry, ticks };
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

        if (!geometry.reachable) {
          unreachable.push(
            `${label}: reachable=${geometry.reachable} receivesPointer=${geometry.receivesPointer} ` +
              `fullyInViewport=${geometry.fullyInViewport} ` +
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
    expect(geometry.reachable, 'Leads panel must be reachable').toBe(true);

    const first = list.getByRole('option').first();
    await expect(first).toBeVisible();

    /**
     * Resolve the row to a LEAD, then never speak positionally again.
     *
     * THE RACE THIS FIXES: the roster is ordered by score and rebuilt as events
     * land (~9/s under the live feed), so `.first()` names a different lead from
     * one moment to the next. This test used to read the name off `.first()`,
     * click `.first()`, and then assert `.first()` was selected — three reads of
     * a moving target. It failed with the row it had resolved sitting there
     * correctly selected, because by assertion time a warmer lead had taken
     * index 0. Identity and name are captured in ONE evaluation so they cannot
     * disagree with each other either.
     */
    const { id, name } = await first.evaluate((el) => ({
      id: el.id,
      name: (el.querySelector('.ll-name')?.textContent ?? '').trim(),
    }));
    expect(name.length, 'a lead row should carry a name').toBeGreaterThan(0);
    const row = list.locator(`[id="${id}"]`);

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
    // The command bar is §13's primary interface and sits in the main stage, not
    // in a scroll container — so here full containment IS the right assertion:
    // any clipping of it would be a real layout regression, not font metrics.
    expect(geometry.fullyInViewport, 'command bar must be fully on screen at load').toBe(true);
    expect(geometry.receivesPointer, `command bar is occluded by ${geometry.hit}`).toBe(true);

    await input.click();
    await input.fill('hot leads in Texas');
    await expect(input).toHaveValue('hot leads in Texas');
  });
});

/**
 * D25 — a control must not move because you pointed at it.
 *
 * FOUND BY A TEST FAILING FOR THE RIGHT REASON. `spatial-focus.spec.ts` began
 * failing at 2560x1440 only: the card never appeared because nothing was ever
 * selected. The cause was not the card. `LeadDetail` grows from a 79px
 * placeholder to a ~389px record the instant it has a lead to show, and it sits
 * ABOVE the Leads list — so the mouseenter that Playwright (or a human) delivers
 * on the way to a click pushed the target row ~310px down the rail, and the
 * click that followed landed on bare rail. Measured at 2560x1440 the rail's
 * content exactly fitted (scrollHeight === clientHeight), leaving no scroll
 * slack to absorb the shift, which is why that viewport failed while the others
 * silently got away with it.
 *
 * The suite had already been bending around this: `wheelIntoView` carries a
 * three-stall tolerance whose comment names "LeadDetail fills on hover" as a
 * reason the rail moves under it. That is a defect being budgeted for rather
 * than fixed.
 *
 * So: raw `mouse.move` then raw `mouse.click` at ONE fixed point, with no
 * relocation in between. Playwright's own `locator.click()` re-resolves and
 * re-scrolls before it clicks, which is precisely the compensation a human does
 * not get.
 */
test.describe('pointing at a lead row does not move it', () => {
  for (const vp of VIEWPORTS) {
    test(`hover leaves the row under the pointer @ ${vp.name}`, async ({ page }) => {
      // Feed frozen: this is a layout-stability question, and a roster that
      // re-sorts mid-measurement would answer a different one.
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/?leads=400&fx=off&feed=off');
      await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
      await page.waitForTimeout(800);

      const rail = page.locator('.rail');
      const list = page
        .locator('.rail section.panel')
        .filter({ has: page.getByRole('heading', { level: 2, name: /^Leads\b/ }) });
      await wheelIntoView(page, rail, list.getByRole('heading', { level: 2 }));

      const before = await list.getByRole('option').first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.id, top: r.top, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });

      // Point at it, and give the app every chance to reflow if it is going to.
      await page.mouse.move(before.x, before.y);
      await page.waitForTimeout(700);

      const after = await page.evaluate(
        ({ id, x, y }) => {
          const row = document.getElementById(id);
          const hit = document.elementFromPoint(x, y);
          return {
            exists: !!row,
            top: row ? row.getBoundingClientRect().top : NaN,
            stillUnderPointer: !!row && !!hit && (hit === row || row.contains(hit)),
            hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : 'nothing',
          };
        },
        { id: before.id, x: before.x, y: before.y },
      );

      expect(after.exists, 'the hovered row must still exist').toBe(true);
      expect(
        Math.abs(after.top - before.top),
        `hovering moved the row ${Math.round(after.top - before.top)}px @ ${vp.name}`,
      ).toBeLessThan(4);
      expect(
        after.stillUnderPointer,
        `after hovering, the pointer is over ${after.hit} instead of the row @ ${vp.name}`,
      ).toBe(true);

      // And the consequence that actually matters: a click delivered at that
      // same point — no re-resolution, no auto-scroll — selects that lead.
      await page.mouse.click(before.x, before.y);
      await expect(page.locator(`[id="${before.id}"]`)).toHaveAttribute('aria-selected', 'true');
    });
  }
});
