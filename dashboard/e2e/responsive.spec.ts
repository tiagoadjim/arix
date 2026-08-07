import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Layout behaviour on the viewports Arix is actually operated from. Runs on the
 * `mobile` and `tablet` projects only — the functional suite in arix.spec.ts
 * covers a desktop viewport and asserts against the two-pane layout.
 *
 * Expectations are derived from the running project's own width rather than
 * hard-coded, so both projects execute the same file and each checks the side
 * of the `md` breakpoint it sits on.
 */

const mockApiUrl = 'http://127.0.0.1:3101';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

/** The `md` breakpoint, where the master/detail shell becomes two panes. */
const TWO_PANE_MIN_WIDTH = 768;

function viewportWidth(): number {
  return test.info().project.use.viewport?.width ?? 0;
}

function isPhone(): boolean {
  return viewportWidth() < TWO_PANE_MIN_WIDTH;
}

async function resetBackend(request: APIRequestContext, overrides: Record<string, unknown> = {}) {
  const response = await request.post(`${mockApiUrl}/__e2e/reset`, { data: overrides });
  expect(response.ok()).toBeTruthy();
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/**
 * The single most useful responsive assertion: nothing may push the document
 * wider than the viewport. A stray fixed width or an unbreakable string shows
 * up here as a sideways scrollbar long before anyone notices it by eye.
 */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  // One pixel of slack absorbs sub-pixel rounding in the layout engine.
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test.beforeEach(async ({ request }) => {
  await resetBackend(request);
});

test('the login screen fits the viewport', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('Email')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('no console route scrolls sideways', async ({ page }) => {
  await login(page);

  for (const path of ['/', `/c/${CONVERSATION_ID}`, '/analytics', '/config']) {
    await page.goto(path);
    await expect(page.locator('#main-content')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test('every settings tab fits the viewport', async ({ page }) => {
  await login(page);
  await page.goto('/config');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // Business carries the widest content — a two-column field grid plus the
  // seven-row weekly hours editor — and Staff the widest control row.
  for (const tab of ['AI Provider', 'Store', 'MCP', 'Business', 'Staff']) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('data-state', 'active');
    await expectNoHorizontalOverflow(page);
  }
});

test('the inbox and conversation share the screen the way the width allows', async ({ page }) => {
  await login(page);

  const inbox = page.getByRole('complementary', { name: 'Conversation inbox' });
  await expect(inbox).toBeVisible();

  await page.getByRole('link', { name: /Ada Customer/ }).click();
  await expect(page.getByRole('heading', { name: 'Ada Customer' })).toBeVisible();

  const back = page.getByRole('link', { name: 'Back to conversations' });

  if (isPhone()) {
    // One pane at a time, with an explicit way back — otherwise a phone would
    // strand whoever opened a conversation.
    await expect(inbox).toBeHidden();
    await expect(back).toBeVisible();
    await back.click();
    await expect(inbox).toBeVisible();
  } else {
    // Wide enough for both, so the back control would only take up room.
    await expect(inbox).toBeVisible();
    await expect(back).toBeHidden();
  }

  await expectNoHorizontalOverflow(page);
});

test('the composer stays inside the viewport once a chat is taken over', async ({ page }) => {
  await login(page);
  await page.goto(`/c/${CONVERSATION_ID}`);

  await page.getByRole('button', { name: 'Take chat' }).click();
  const composer = page.getByPlaceholder('Type your reply…');
  await expect(composer).toBeVisible();

  const box = await composer.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  // Fully on screen, both edges — a composer half off the bottom is the
  // classic mobile chat failure.
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);

  await expectNoHorizontalOverflow(page);
});

test('usage figures are readable without sideways scrolling', async ({ page }) => {
  await login(page);
  await page.goto('/analytics');
  await expect(page.getByRole('heading', { name: 'Analytics and audit' })).toBeVisible();

  const table = page.getByRole('table');
  const cards = page.getByRole('listitem').filter({ hasText: 'gpt-4.1-mini' });

  if (viewportWidth() < 768) {
    // A seven-column table cannot be read on a phone, so the same rows are
    // rendered as cards instead.
    await expect(table).toBeHidden();
    await expect(cards.first()).toBeVisible();
  } else {
    await expect(table).toBeVisible();
  }

  await expectNoHorizontalOverflow(page);
});

test('conversation details open in a drawer that fits the screen', async ({ page }) => {
  await login(page);
  await page.goto(`/c/${CONVERSATION_ID}`);

  // Both projects are narrower than the `xl` breakpoint that earns a docked
  // details column, so both get the drawer.
  await page.getByRole('button', { name: 'View orders and receipts' }).click();

  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();

  const box = await drawer.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.height).toBeLessThanOrEqual(viewport!.height + 1);

  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(drawer).toBeHidden();
});
