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

test('first-run setup creates the admin session and enters configuration', async ({ page, request }) => {
  await resetBackend(request, { needsSetup: true, setupCompleted: false });
  await page.goto('/setup');

  await expect(page.getByRole('heading', { name: 'Welcome to Arix' })).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByLabel('Setup token').fill('e2e-setup-token-at-least-32-characters-long');
  await page.getByLabel('Name').fill('E2E Admin');
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Choose your AI provider' })).toBeVisible();
  const state = await (await request.get(`${mockApiUrl}/__e2e/state`)).json();
  expect(state).toMatchObject({ needsSetup: false, setupCompleted: false, adminEmail: 'owner@example.com' });
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
