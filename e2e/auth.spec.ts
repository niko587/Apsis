/**
 * Authentication, from the browser.
 *
 * Every route is mocked — **no WorkOS account, no credential, no network**.
 * What a browser proves that server tests cannot: that the DEFAULT build is
 * untouched by any of this, that a 401 degrades into the grammar instead of an
 * error state, and that a 503 does not tell a signed-in user they have been
 * logged out.
 */

import { test, expect, type Page } from '@playwright/test';

const APP = '/?leads=400&fx=off&feed=off';
const ENDPOINT = '/api/interpret';

async function declareInterpreter(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__APSIS_COMMAND_INTERPRETER__ = {
      endpoint: '/api/interpret',
    };
  });
}

const mockSession = (page: Page, body: unknown) =>
  page.route('**/api/session', (route) => route.fulfill({ json: body as object }));

async function boot(page: Page, url = APP) {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
  await page.waitForTimeout(1000);
}

async function submit(page: Page, text: string) {
  await page.getByLabel('Command Apsis').fill(text);
  await page.keyboard.press('Enter');
}

const note = (page: Page) => page.locator('[data-interpreter-note]');
const signIn = (page: Page) => page.locator('[data-auth-signin]');
const signOut = (page: Page) => page.locator('[data-auth-signout]');
const unavailable = (page: Page) => page.locator('[data-auth-unavailable]');

test.describe('the default build is untouched by authentication', () => {
  test('no interpreter declared: no sign-in affordance, and zero requests', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith('http://localhost:4173/') || /\/api\//.test(url)) calls.push(url);
    });

    await boot(page);
    await submit(page, 'find cold leads in Florida');
    await page.waitForTimeout(800);

    // The whole auth surface is absent, because there is nothing to sign in for.
    await expect(signIn(page)).toHaveCount(0);
    await expect(signOut(page)).toHaveCount(0);
    expect(calls, `unexpected requests: ${calls.join(', ')}`).toEqual([]);
    await expect(page.locator('.command-result')).toContainText('leads matched');
  });
});

test.describe('signed out', () => {
  test('offers sign-in and still answers with the grammar', async ({ page }) => {
    await declareInterpreter(page);
    await mockSession(page, { authenticated: false });
    await page.route(`**${ENDPOINT}`, (route) =>
      route.fulfill({ status: 401, json: { error: 'unauthenticated' } }),
    );

    await boot(page);
    await expect(signIn(page)).toBeVisible();
    await expect(signIn(page)).toHaveAttribute('href', /\/api\/auth\/login\?returnTo=/);

    await submit(page, 'find cold leads in Florida');
    await page.waitForTimeout(1200);

    // The command RAN. A 401 is not an error state.
    await expect(page.locator('.understood .chip')).toContainText(['stage is Cold']);
    await expect(page.locator('.command-result')).toContainText('leads matched');
    await expect(note(page)).toHaveText(/sign in to use the language model/);
    await expect(page.getByLabel('Command Apsis')).toBeEnabled();
  });

  test('the Universe is not gated — the app is fully usable signed out', async ({ page }) => {
    await declareInterpreter(page);
    await mockSession(page, { authenticated: false });
    await boot(page);

    // Drill, select, inspect: none of it asks who you are.
    await page.locator('.uv-clusters button', { hasText: 'West' }).first().click();
    await page.waitForTimeout(700);
    await expect(page.locator('.uv-crumbs li')).toHaveCount(2);
    await expect(page.getByRole('option').first()).toBeVisible();
  });
});

test.describe('signed in', () => {
  test('shows a sign-out affordance and interprets normally', async ({ page }) => {
    await declareInterpreter(page);
    await mockSession(page, { authenticated: true, userId: 'user_1', capabilities: ['interpreter:use'] });
    await page.route(`**${ENDPOINT}`, (route) =>
      route.fulfill({
        json: { filters: [{ field: 'states', value: 'FL', span: 'sunshine state' }] },
      }),
    );

    await boot(page);
    await expect(signOut(page)).toBeVisible();
    await expect(signIn(page)).toHaveCount(0);

    await submit(page, 'which folks in the sunshine state are worth a call?');
    await page.waitForTimeout(1200);

    await expect(page.locator('.understood .chip')).toContainText(['state is Florida']);
    // Interpreted, not fallen back.
    await expect(note(page)).toHaveCount(0);
  });

  test('never receives a token or an email', async ({ page }) => {
    await declareInterpreter(page);
    await mockSession(page, {
      authenticated: true,
      userId: 'user_1',
      organizationId: null,
      capabilities: ['interpreter:use'],
    });
    await boot(page);

    // Whatever the server chose to send, nothing token-shaped may be reachable
    // from script — and the session cookie is HttpOnly by construction.
    const exposed = await page.evaluate(() => ({
      cookie: document.cookie,
      storage: JSON.stringify({ ...localStorage, ...sessionStorage }),
    }));
    for (const needle of ['sealed', 'refresh', 'access_token', 'sk_', 'workos', '@']) {
      expect(exposed.cookie.toLowerCase(), needle).not.toContain(needle);
      expect(exposed.storage.toLowerCase(), needle).not.toContain(needle);
    }
  });
});

test.describe('a session problem is not an error state', () => {
  test('503 does NOT present the user as logged out', async ({ page }) => {
    await declareInterpreter(page);
    // Signed in, but the sign-in service is briefly unreachable.
    await mockSession(page, { authenticated: true, userId: 'user_1' });
    await page.route(`**${ENDPOINT}`, (route) =>
      route.fulfill({
        status: 503,
        headers: { 'retry-after': '5' },
        json: { error: 'auth_unavailable' },
      }),
    );

    await boot(page);
    await submit(page, 'find cold leads in Florida');
    await page.waitForTimeout(1200);

    await expect(note(page)).toHaveText(/temporarily unavailable/);
    // The decisive assertion: the user is NOT told to sign in, and the
    // signed-in affordance is still there (D40).
    await expect(note(page)).not.toHaveText(/sign in to use/);
    await expect(signOut(page)).toBeVisible();
    await expect(page.locator('.command-result')).toContainText('leads matched');
  });

  test('403 falls back like 401, without an error state', async ({ page }) => {
    await declareInterpreter(page);
    await mockSession(page, { authenticated: true, userId: 'user_1' });
    await page.route(`**${ENDPOINT}`, (route) =>
      route.fulfill({ status: 403, json: { error: 'forbidden' } }),
    );

    await boot(page);
    await submit(page, 'find cold leads in Florida');
    await page.waitForTimeout(1200);
    await expect(page.locator('.command-result')).toContainText('leads matched');
    await expect(note(page)).toBeVisible();
  });

  test('a session endpoint that fails does not break the command bar', async ({ page }) => {
    await declareInterpreter(page);
    await page.route('**/api/session', (route) => route.abort());
    await page.route(`**${ENDPOINT}`, (route) =>
      route.fulfill({ status: 401, json: { error: 'unauthenticated' } }),
    );

    await boot(page);
    await submit(page, 'find cold leads in Florida');
    await page.waitForTimeout(1200);
    await expect(page.locator('.command-result')).toContainText('leads matched');
  });
});

test.describe('accessibility and the rest of Apsis', () => {
  test('adds no live region and stays keyboard-usable', async ({ page }) => {
    await declareInterpreter(page);
    await mockSession(page, { authenticated: false });
    await page.route(`**${ENDPOINT}`, (route) =>
      route.fulfill({ status: 401, json: { error: 'unauthenticated' } }),
    );

    await boot(page);
    const liveBefore = await page.locator('[role=status], [aria-live]').count();

    await page.getByLabel('Command Apsis').focus();
    await page.keyboard.type('find cold leads in Florida');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);

    expect(await page.locator('[role=status], [aria-live]').count()).toBe(liveBefore);
    expect(
      await signIn(page).evaluate((el) => !!el.closest('[role=status], [aria-live]')),
    ).toBe(false);
  });

  test('persistence and replay are unaffected by authentication', async ({ page }) => {
    await declareInterpreter(page);
    await mockSession(page, { authenticated: false });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await boot(page, '/?leads=400&fx=off&diag=1&source=replay');
    await page.waitForTimeout(2500);
    await expect(page.locator('[data-persistence]')).toContainText('isolated');

    await boot(page, '/?leads=400&fx=off&diag=1');
    await page.waitForTimeout(3500);
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Leads\b/ })).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page.locator('[data-persistence]')).toContainText('restored');
    expect(errors, errors.join(' | ')).toEqual([]);
  });
});

/**
 * TRANSITIONS, not isolated states.
 *
 * Each of these starts from a SIGNED-IN page and then makes one protected call
 * fail in a particular way. What matters is where the UI ends up — three
 * different statuses have three different correct destinations, and collapsing
 * them is how a user gets told to sign in when they already are.
 */
test.describe('session transitions from signed-in', () => {
  const signedInThen = async (page: Page, status: number, body: object, headers = {}) => {
    await declareInterpreter(page);
    await mockSession(page, { authenticated: true, userId: 'user_1' });
    await page.route(`**${ENDPOINT}`, (route) => route.fulfill({ status, json: body, headers }));
    await boot(page);
    // Precondition: genuinely signed in before anything fails.
    await expect(signOut(page)).toBeVisible();
    await submit(page, 'find cold leads in Florida');
    await page.waitForTimeout(1300);
  };

  test('A · 401 → signed out: sign-out disappears, sign-in appears', async ({ page }) => {
    await signedInThen(page, 401, { error: 'unauthenticated' });

    await expect(page.locator('.command-result')).toContainText('leads matched');
    await expect(signOut(page)).toHaveCount(0);
    await expect(signIn(page)).toBeVisible();
    await expect(note(page)).toHaveText(/sign in to use the language model/);
  });

  test('B · 403 → stays signed in, and does NOT tell the user to sign in', async ({ page }) => {
    await signedInThen(page, 403, { error: 'forbidden' });

    await expect(page.locator('.command-result')).toContainText('leads matched');
    // The account is signed in; sending them to a sign-in page would loop.
    await expect(signOut(page)).toBeVisible();
    await expect(signIn(page)).toHaveCount(0);
    await expect(note(page)).toHaveText(/not available for this account/);
    await expect(note(page)).not.toHaveText(/sign in to use/);
  });

  test('C · 503 → stays signed in, no signed-out claim', async ({ page }) => {
    await signedInThen(page, 503, { error: 'auth_unavailable' }, { 'retry-after': '5' });

    await expect(page.locator('.command-result')).toContainText('leads matched');
    await expect(signOut(page)).toBeVisible();
    await expect(signIn(page)).toHaveCount(0);
    await expect(note(page)).toHaveText(/temporarily unavailable/);
  });
});

test.describe('session status on first load', () => {
  test('a 503 from /api/session does not claim signed out', async ({ page }) => {
    await declareInterpreter(page);
    await page.route('**/api/session', (route) =>
      route.fulfill({ status: 503, headers: { 'retry-after': '5' }, json: { error: 'auth_unavailable' } }),
    );
    await boot(page);

    // Neither a sign-in invitation nor a false signed-in state.
    await expect(signIn(page)).toHaveCount(0);
    await expect(signOut(page)).toHaveCount(0);
    await expect(unavailable(page)).toBeVisible();
  });

  test('an unreachable /api/session does not claim signed out either', async ({ page }) => {
    await declareInterpreter(page);
    await page.route('**/api/session', (route) => route.abort());
    await boot(page);
    await expect(signIn(page)).toHaveCount(0);
    await expect(unavailable(page)).toBeVisible();
  });
});

test.describe('sign-out is a POST', () => {
  test('the control is a submit button in a same-origin POST form', async ({ page }) => {
    await declareInterpreter(page);
    await mockSession(page, { authenticated: true, userId: 'user_1' });
    await boot(page);

    const shape = await signOut(page).evaluate((el) => {
      const form = el.closest('form');
      return {
        tag: el.tagName,
        type: el.getAttribute('type'),
        method: form?.getAttribute('method')?.toLowerCase() ?? null,
        action: form?.getAttribute('action') ?? null,
        // A GET link would be the defect: any cross-site <img> could fire it.
        isAnchor: el.tagName === 'A',
      };
    });
    expect(shape.isAnchor, 'sign-out must not be a link').toBe(false);
    expect(shape.tag).toBe('BUTTON');
    expect(shape.type).toBe('submit');
    expect(shape.method).toBe('post');
    expect(shape.action).toBe('/api/auth/logout');
  });

  test('it is reachable and operable from the keyboard', async ({ page }) => {
    await declareInterpreter(page);
    await mockSession(page, { authenticated: true, userId: 'user_1' });
    let posts = 0;
    await page.route('**/api/auth/logout', (route) => {
      posts++;
      expect(route.request().method()).toBe('POST');
      return route.fulfill({ status: 302, headers: { location: '/' }, body: '' });
    });
    await boot(page);

    await signOut(page).focus();
    await expect(signOut(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    expect(posts).toBe(1);
  });
});
