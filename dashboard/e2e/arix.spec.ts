import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const mockApiUrl = 'http://127.0.0.1:3101';

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
  await expect(page.getByRole('heading', { name: 'Conversation inbox' })).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await resetBackend(request);
});

async function createFirstAdmin(page: Page) {
  await expect(page.getByRole('heading', { name: 'Welcome to Arix' })).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByRole('button', { name: 'Get started' }).click();

  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('One-time setup code').fill('e2e-setup-token-at-least-32-characters-long');
  await page.getByLabel('Your name').fill('E2E Admin');
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Repeat password').fill('password123');
  await page.getByRole('button', { name: 'Create my account' }).click();
}

test('first-run setup creates the admin session and moves on to the store', async ({ page, request }) => {
  await resetBackend(request, { needsSetup: true, setupCompleted: false });
  await page.goto('/setup');
  await createFirstAdmin(page);

  await expect(page.getByRole('heading', { name: 'Connect your store' })).toBeVisible();
  const state = await (await request.get(`${mockApiUrl}/__e2e/state`)).json();
  expect(state).toMatchObject({ needsSetup: false, setupCompleted: false, adminEmail: 'owner@example.com' });
});

test('the store step falls back to copying the keys, with no extra clicks', async ({ page, request }) => {
  // A local install can never use WooCommerce's one-click flow, so this is the
  // path most people will actually see. It has to appear on its own.
  await resetBackend(request, { needsSetup: true, setupCompleted: false, wooAuthMode: 'manual' });
  await page.goto('/setup');
  await createFirstAdmin(page);

  await page.getByLabel('Your store address').fill('shop.example.com');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Copy the keys across' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Open the keys page/ })).toHaveAttribute(
    'href',
    /create-key=1/,
  );

  // Pasting the whole WooCommerce success screen fills both halves.
  await page
    .getByLabel('Paste what your store shows you')
    .fill(`Consumer key\nck_${'a'.repeat(40)}\nConsumer secret\ncs_${'b'.repeat(40)}`);
  await expect(page.getByText('Got both keys.')).toBeVisible();
});

test('the website scan proposes settings and saves only what was kept', async ({ page, request }) => {
  await resetBackend(request, { needsSetup: true, setupCompleted: false });
  await page.goto('/setup');
  await createFirstAdmin(page);

  // Walk forward rather than jumping: the rail deliberately refuses to skip
  // ahead of the furthest screen actually reached.
  await page.getByRole('button', { name: 'Next' }).click();

  // Reading the website needs a working assistant, so set one up on the way.
  await expect(page.getByRole('heading', { name: 'Choose the assistant' })).toBeVisible();
  await page.getByLabel('API key').fill('sk-e2e-test-key');
  await page.getByRole('button', { name: 'Check the key' }).click();
  await expect(page.getByText(/Working\. Using/)).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Let Arix read your website' })).toBeVisible();
  await page.getByRole('button', { name: 'Read my website' }).click();

  await expect(page.getByRole('heading', { name: 'Here is what we found' })).toBeVisible();

  // Nothing is accepted by default — that review is the containment boundary
  // for text read off a website Arix does not control.
  const shipping = page.getByRole('checkbox', { name: 'How you ship' });
  const payment = page.getByRole('checkbox', { name: 'How customers pay you' });
  await expect(shipping).not.toBeChecked();
  await expect(payment).not.toBeChecked();

  // The suggestion carrying an ungrounded account number is flagged.
  await expect(page.getByText(/could not find on your site/)).toBeVisible();

  // "Keep everything without a warning" skips exactly that one.
  await page.getByRole('button', { name: 'Keep everything without a warning' }).click();
  await expect(shipping).toBeChecked();
  await expect(payment).not.toBeChecked();

  await page.getByRole('button', { name: 'Save what I kept' }).click();
  const state = await (await request.get(`${mockApiUrl}/__e2e/state`)).json();
  expect(state.lastSettingsUpdate).toEqual([
    { key: 'info.shipping', value: 'We ship nationwide in 3 to 5 business days.' },
  ]);
});

test('staff can sign in and see the inbox', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('link', { name: /Ada Customer/ })).toBeVisible();
  await expect(page.getByText('Do you have this in stock?')).toBeVisible();
});

test('staff can take over a bot conversation', async ({ page, request }) => {
  await login(page);
  await page.getByRole('link', { name: /Ada Customer/ }).click();

  await expect(page.getByRole('heading', { name: 'Ada Customer' })).toBeVisible();
  await page.getByRole('button', { name: 'Take chat' }).click();
  await expect(page.getByRole('button', { name: 'Return to Arix' })).toBeVisible();
  await expect(page.getByPlaceholder('Type your reply…')).toBeVisible();

  const state = await (await request.get(`${mockApiUrl}/__e2e/state`)).json();
  expect(state.conversations[0].mode).toBe('human');
});

test('an admin can update business settings', async ({ page, request }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await page.getByRole('tab', { name: 'Business' }).click();
  await page.getByLabel('Business name').fill('E2E Updated Store');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  const state = await (await request.get(`${mockApiUrl}/__e2e/state`)).json();
  expect(state.lastSettingsUpdate).toEqual(
    expect.arrayContaining([{ key: 'business.name', value: 'E2E Updated Store' }]),
  );
});

test('an admin can inspect analytics, audit and runtime metrics', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Analytics' }).click();

  await expect(page.getByRole('heading', { name: 'Analytics and audit' })).toBeVisible();
  await expect(page.getByRole('row', { name: /openai gpt-4\.1-mini/ })).toBeVisible();

  await page.getByRole('tab', { name: 'Recent audit activity' }).click();
  await expect(page.getByText('settings.updated')).toBeVisible();

  await page.getByRole('tab', { name: 'Runtime metrics' }).click();
  await expect(page.getByText('arix_http_requests_total 42')).toBeVisible();
});

test('an agent cannot open admin analytics', async ({ page, request }) => {
  await resetBackend(request, { loginRole: 'agent' });
  await login(page);
  await expect(page.getByRole('link', { name: 'Analytics' })).toHaveCount(0);

  await page.goto('/analytics');

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Conversation inbox' })).toBeVisible();
});
