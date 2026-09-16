/**
 * Opt-in LLM command interpretation — browser acceptance.
 *
 * What a browser proves that unit tests cannot: that the DEFAULT build, the one
 * the owner actually runs, never reaches for the network; that a real
 * interpretation drives the real funnel and the real field; and that a provider
 * failure leaves a usable command bar rather than an error state.
 *
 * Every interpreter here is a Playwright route. No vendor is contacted, no
 * credential exists, and there is nothing in the bundle that could hold one.
 */

import { test, expect, type Page } from '@playwright/test';

/** Small book, effects off, feed frozen: this suite tests parsing, not throughput. */
const APP = '/?leads=400&fx=off&feed=off';
const ENDPOINT = '/api/interpret';

/** Declare a host interpreter before any application code runs. */
async function declareInterpreter(page: Page, timeoutMs?: number) {
  await page.addInitScript(
    ([endpoint, ms]) => {
      (window as unknown as Record<string, unknown>).__APSIS_COMMAND_INTERPRETER__ = {
        endpoint,
        ...(typeof ms === 'number' ? { timeoutMs: ms } : {}),
      };
    },
    [ENDPOINT, timeoutMs] as const,
  );
}

async function boot(page: Page, url = APP) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
  await page.waitForTimeout(1200);
}

async function submit(page: Page, text: string) {
  await page.getByLabel('Command Apsis').fill(text);
  await page.keyboard.press('Enter');
}

const chips = (page: Page) => page.locator('.understood .chip');
const ignored = (page: Page) => page.locator('.chip-unknown');
const note = (page: Page) => page.locator('[data-interpreter-note]');

test.describe('with no interpreter declared — the default build', () => {
  test('the command bar behaves exactly as it does today', async ({ page }) => {
    await boot(page);
    await submit(page, 'find cold leads in Florida');
    await page.waitForTimeout(800);

    await expect(page.locator('.funnel li').first()).toBeVisible();
    await expect(chips(page)).toContainText(['stage is Cold']);
    await expect(page.locator('.command-result')).toContainText('leads matched');
    // Nothing explains which parser ran, because there was only ever one.
    await expect(note(page)).toHaveCount(0);
  });

  test('makes ZERO network requests — nothing even tries', async ({ page }) => {
    const calls: string[] = [];
    // Watch everything, not just the endpoint: a vendor SDK sneaking in would
    // not politely use the path we expected.
    page.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith('http://localhost:4173/') || /\/api\//.test(url)) calls.push(url);
    });
    await page.route('**/api/**', (route) => route.abort());

    await boot(page);
    for (const text of [
      'find cold family leads in Tampa',
      'show qualified leads with score above 80, top 25',
      'find hot medicare leads in Orlando, call them',
    ]) {
      await submit(page, text);
      await page.waitForTimeout(600);
    }
    expect(calls, `unexpected requests: ${calls.join(', ')}`).toEqual([]);
  });

  test('?interpreter=off forces the grammar even when a host declares one', async ({ page }) => {
    await declareInterpreter(page);
    let hits = 0;
    await page.route(`**${ENDPOINT}`, (route) => {
      hits++;
      return route.fulfill({ json: { filters: [] } });
    });

    await boot(page, `${APP}&interpreter=off`);
    await submit(page, 'find cold leads in Miami');
    await page.waitForTimeout(900);

    expect(hits).toBe(0);
    await expect(page.locator('.command-result')).toContainText('leads matched');
    await expect(note(page)).toHaveCount(0);
  });
});

test.describe('with a declared interpreter', () => {
  test('a novel phrasing the grammar cannot read filters the field', async ({ page }) => {
    await declareInterpreter(page);
    // Deliberately contains no stage word, no city and no state name: if the
    // grammar could parse this, the test would prove nothing.
    const text = 'which folks in the sunshine state have gone quiet for a fortnight?';
    await page.route(`**${ENDPOINT}`, async (route) => {
      const body = route.request().postDataJSON() as { text: string; schema: unknown };
      expect(body.text).toBe(text);
      expect(body.schema).toBeTruthy();
      await route.fulfill({
        json: {
          filters: [
            { field: 'states', value: 'FL', span: 'sunshine state' },
            { field: 'idleDaysMin', value: 14, span: 'gone quiet for a fortnight' },
          ],
        },
      });
    });

    await boot(page);
    await submit(page, text);
    await page.waitForTimeout(1200);

    await expect(chips(page)).toContainText(['no contact for 14+ days', 'state is Florida']);
    await expect(page.locator('.funnel')).toContainText('Florida');
    await expect(page.locator('.command-result')).toContainText('leads matched');
    await expect(note(page)).toHaveCount(0);
  });

  test('clauses it could not map stay visible', async ({ page }) => {
    await declareInterpreter(page);
    await page.route(`**${ENDPOINT}`, (route) =>
      route.fulfill({
        json: {
          // The model claims it understood everything. It did not, and the
          // residue is computed from the user's own words rather than believed.
          filters: [{ field: 'stages', value: 'hot', span: 'hot' }],
          unmapped: [],
        },
      }),
    );

    await boot(page);
    await submit(page, 'hot leads who sounded frustrated on the call');
    await page.waitForTimeout(1200);

    await expect(ignored(page)).toContainText(['ignored: sounded']);
    await expect(ignored(page)).toContainText(['ignored: frustrated']);
  });

  test('a hallucinated citation is refused at the door', async ({ page }) => {
    await declareInterpreter(page);
    await page.route(`**${ENDPOINT}`, (route) =>
      route.fulfill({
        json: {
          filters: [
            { field: 'stages', value: 'cold', span: 'cold' },
            // Nobody typed "Florida". An interpreter that cannot point at its
            // own evidence does not get to filter the book.
            { field: 'states', value: 'FL', span: 'Florida' },
          ],
        },
      }),
    );

    await boot(page);
    await submit(page, 'cold leads in Texas');
    await page.waitForTimeout(1200);

    await expect(chips(page)).toContainText(['stage is Cold']);
    await expect(page.locator('.understood')).not.toContainText('state is Florida');
    await expect(ignored(page)).toContainText(['ignored: texas']);
  });

  test('a provider failure still renders results, with one honest line', async ({ page }) => {
    await declareInterpreter(page);
    await page.route(`**${ENDPOINT}`, (route) => route.fulfill({ status: 500, body: 'nope' }));

    await boot(page);
    await submit(page, 'find cold leads in Florida');
    await page.waitForTimeout(1500);

    // The grammar's answer, in full — not an error state.
    await expect(chips(page)).toContainText(['stage is Cold']);
    await expect(page.locator('.funnel li').first()).toBeVisible();
    await expect(page.locator('.command-result')).toContainText('leads matched');
    await expect(note(page)).toHaveText(/built-in grammar/);

    // And the bar is still usable immediately afterwards.
    await expect(page.getByLabel('Command Apsis')).toBeEnabled();
    await submit(page, 'show leads with score above 80, top 25');
    await page.waitForTimeout(1500);
    await expect(page.locator('.command-result')).toContainText('leads matched');
  });

  test('a timeout falls back rather than hanging the command bar', async ({ page }) => {
    await declareInterpreter(page, 700);
    // Never answers. The bar must not sit on "Running…" forever.
    await page.route(`**${ENDPOINT}`, () => {});

    await boot(page);
    await submit(page, 'find cold leads in Miami');
    await page.waitForTimeout(3000);

    await expect(note(page)).toHaveText(/did not answer in time/);
    await expect(page.locator('.command-result')).toContainText('leads matched');
    await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();
  });

  test('stays keyboard-usable and announces nothing new', async ({ page }) => {
    await declareInterpreter(page);
    await page.route(`**${ENDPOINT}`, (route) => route.fulfill({ status: 500, body: '' }));

    await boot(page);
    const liveBefore = await page.locator('[role=status], [aria-live]').count();

    const input = page.getByLabel('Command Apsis');
    await input.focus();
    await page.keyboard.type('find cold leads in Miami');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    await expect(note(page)).toHaveCount(1);
    // The note is ordinary text inside the existing outcome panel. The
    // StatusAnnouncer remains the only thing that speaks.
    expect(await page.locator('[role=status], [aria-live]').count()).toBe(liveBefore);
    expect(
      await note(page).evaluate((el) => !!el.closest('[role=status], [aria-live]')),
      'the note must not sit inside a live region',
    ).toBe(false);
  });
});

test.describe('the rest of Apsis is unaffected', () => {
  test('replay mode runs with an interpreter declared', async ({ page }) => {
    await declareInterpreter(page);
    await page.route(`**${ENDPOINT}`, (route) => route.fulfill({ json: { filters: [] } }));
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page, '/?leads=400&fx=off&diag=1&source=replay');
    await page.waitForTimeout(2500);
    await expect(page.locator('[data-persistence]')).toContainText('isolated');
    expect(errors, errors.join(' | ')).toEqual([]);
  });

  test('a persisted session still survives a reload', async ({ page }) => {
    await declareInterpreter(page);
    await page.route(`**${ENDPOINT}`, (route) => route.fulfill({ json: { filters: [] } }));

    await boot(page, '/?leads=400&fx=off&diag=1');
    await page.waitForTimeout(4000);
    await expect(page.locator('[data-persistence]')).toContainText(/fresh|restored/);

    await page.reload();
    await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page.locator('[data-persistence]')).toContainText('restored');
  });
});
