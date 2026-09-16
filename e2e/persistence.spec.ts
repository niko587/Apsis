/**
 * Persistence across a real page reload.
 *
 * The unit tests prove the log round-trips and that hydration reproduces
 * canonical state. They cannot prove the thing the user actually cares about —
 * that a browser refresh does not cost you your session — because that involves
 * IndexedDB, the boot ordering, and React's effect lifecycle. Only a real
 * browser can answer it, which is the same reason `reachability.spec.ts` exists.
 *
 * A fresh `browser.newContext()` gets its own IndexedDB, so "fresh install" and
 * "returning user" are genuinely different here rather than simulated.
 */

import { test, expect, type Page } from '@playwright/test';

/** Small book, effects off: this suite tests state, not throughput. */
const APP = '/?leads=400&fx=off&diag=1';

const bookedCount = async (page: Page): Promise<number> => {
  const text = (await page.locator('.center-n').textContent()) ?? '0';
  return Number.parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
};

const persistenceLine = async (page: Page): Promise<string> =>
  (await page.locator('[data-persistence]').textContent()) ?? '';

async function boot(page: Page, url = APP, settleMs = 3500) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
  await page.waitForTimeout(settleMs);
}

test.describe('persistence across reload', () => {
  test('a session survives a refresh, and reset returns the seeded book', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // 1. Fresh install: nothing restored.
    await boot(page);
    expect(await persistenceLine(page)).toMatch(/fresh/);

    // 2. Let the simulator move the book, then pause so the numbers hold still.
    await page.waitForTimeout(4000);
    await page.getByRole('button', { name: 'Pause feed' }).click();
    const bookedBefore = await bookedCount(page);
    const eventsBefore = Number(
      (await persistenceLine(page)).match(/· (\d+) events/)?.[1] ?? '0',
    );
    expect(eventsBefore).toBeGreaterThan(0);

    // 3. Reload. The saved log must be replayed before any source starts.
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
    await page.waitForTimeout(3000);

    const line = await persistenceLine(page);
    expect(line).toMatch(/restored/);
    const eventsAfter = Number(line.match(/· (\d+) events/)?.[1] ?? '0');
    expect(eventsAfter).toBeGreaterThanOrEqual(eventsBefore);

    // Booked leads are the most visible piece of restored state: only
    // `appointment_booked` reaches the centre (D3), so this number cannot climb
    // by accident during hydration.
    await page.getByRole('button', { name: 'Pause feed' }).click();
    expect(await bookedCount(page)).toBeGreaterThanOrEqual(bookedBefore);

    // 4. Reset is two-step on purpose; one click only arms it.
    await page.getByRole('button', { name: 'Reset session' }).click();
    await expect(page.getByRole('button', { name: 'Confirm reset' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm reset' }).click();

    // Reset reloads the page; the book comes back seeded and unrestored.
    await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2500);
    expect(await persistenceLine(page)).toMatch(/fresh/);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
    await context.close();
  });

  test('a fresh context starts clean — persistence is per-browser, not global', async ({ browser }) => {
    const first = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const a = await first.newPage();
    await boot(a);
    await a.waitForTimeout(3000);
    expect(Number((await persistenceLine(a)).match(/· (\d+) events/)?.[1] ?? '0')).toBeGreaterThan(0);
    await first.close();

    const second = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const b = await second.newPage();
    await boot(b);
    expect(await persistenceLine(b)).toMatch(/fresh/);
    await second.close();
  });

  test('replay mode is isolated and cannot overwrite a real session', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // Build up a normal persisted session first.
    await boot(page);
    await page.waitForTimeout(4000);
    await page.getByRole('button', { name: 'Pause feed' }).click();
    const eventsBefore = Number(
      (await persistenceLine(page)).match(/· (\d+) events/)?.[1] ?? '0',
    );
    expect(eventsBefore).toBeGreaterThan(0);

    // Run the replay demo — it must neither restore nor record.
    await boot(page, '/?leads=400&fx=off&diag=1&source=replay', 4000);
    expect(await persistenceLine(page)).toMatch(/isolated/);

    // Back to the normal session: the log is exactly as the demo found it.
    await boot(page);
    const line = await persistenceLine(page);
    expect(line).toMatch(/restored/);
    const eventsAfter = Number(line.match(/· (\d+) events/)?.[1] ?? '0');
    expect(eventsAfter).toBeGreaterThanOrEqual(eventsBefore);

    await context.close();
  });
});
