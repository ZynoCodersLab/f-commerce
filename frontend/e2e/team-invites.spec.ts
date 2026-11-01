import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// E2E for team and staff invites (spec 0009).
// Requires the dev stack: backend on :4000, frontend on :3000, PostgreSQL running.
// Covers AC-1, AC-5, AC-6, AC-7, AC-11, AC-13, AC-21.
// Run with: npm run e2e --workspace @f-commerce/frontend

test.use({ baseURL: 'http://localhost:3000' });

const password = 'password123';

async function registerOwner(
  apiRequest: APIRequestContext,
): Promise<{ accessToken: string; businessId: string }> {
  const email = `owner-${randomUUID()}@example.com`;
  const response = await apiRequest.post('/api/auth/register', {
    data: { email, password, name: 'Maya Owner', businessName: `Threads ${randomUUID()}` },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { accessToken: string };
  const payload = JSON.parse(
    Buffer.from(body.accessToken.split('.')[1] ?? '', 'base64').toString(),
  ) as { memberships?: { businessId?: string }[] };
  return { accessToken: body.accessToken, businessId: payload.memberships?.[0]?.businessId ?? '' };
}

async function useSession(page: Page, accessToken: string, businessId: string) {
  await page.addInitScript(
    (auth) => {
      window.localStorage.setItem('accessToken', auth.accessToken);
      window.localStorage.setItem('businessId', auth.businessId);
    },
    { accessToken, businessId },
  );
}

test.describe('team and staff invites', () => {
  test('invites, shows the one time link, and sends the invitee through it', async ({
    page,
    request: apiRequest,
  }) => {
    const owner = await registerOwner(apiRequest);
    await useSession(page, owner.accessToken, owner.businessId);

    await page.goto('/settings/team');
    await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
    await expect(page.getByText('Maya Owner').first()).toBeVisible();

    const invitee = `staff-${randomUUID()}@example.com`;
    await page.getByLabel(/email address/i).fill(invitee);
    await page.getByRole('button', { name: /send invitation/i }).click();

    const link = page.locator('code');
    await expect(link).toContainText('/invite/');
    const inviteUrl = (await link.textContent())?.trim() ?? '';
    expect(inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);

    // The invitee is listed with a status word, not just a colour.
    await expect(page.getByText(invitee).first()).toBeVisible();
    await expect(page.getByText(/not emailed|sending|email sent/i).first()).toBeVisible();

    // The public page describes the invitation before asking for a password.
    const invitePage = await page.context().newPage();
    await invitePage.goto(inviteUrl);
    await expect(invitePage.getByText(/invited you to join/i)).toBeVisible();
    await expect(invitePage.getByText(invitee)).toBeVisible();
    await expect(invitePage.getByRole('heading', { level: 1 })).toBeVisible();

    await invitePage.getByLabel(/your name/i).fill('Sam Staff');
    await invitePage.getByLabel(/password/i).fill(password);
    await invitePage.getByRole('button', { name: /^join /i }).click();

    await invitePage.waitForURL('**/dashboard');
    await expect(
      invitePage.getByRole('heading', { name: /good (morning|afternoon|evening)/i }),
    ).toBeVisible();
    await invitePage.close();

    // The new member now appears for the owner.
    await page.reload();
    await expect(page.getByText('Sam Staff').first()).toBeVisible();

    // The used link is politely refused.
    const reused = await page.request.get(inviteUrl.replace('http://localhost:3000', ''));
    expect([409, 410]).toContain(reused.status());
  });

  test('cancels a pending invitation so its link stops working', async ({
    page,
    request: apiRequest,
  }) => {
    const owner = await registerOwner(apiRequest);
    await useSession(page, owner.accessToken, owner.businessId);

    await page.goto('/settings/team');
    const invitee = `cancel-${randomUUID()}@example.com`;
    await page.getByLabel(/email address/i).fill(invitee);
    await page.getByRole('button', { name: /send invitation/i }).click();
    const inviteUrl = (await page.locator('code').textContent())?.trim() ?? '';

    await page
      .getByRole('row', { name: new RegExp(invitee, 'i') })
      .getByRole('button', { name: /cancel/i })
      .click();
    await page
      .getByRole('dialog', { name: /cancel this invitation/i })
      .getByRole('button', {
        name: /cancel invitation/i,
      })
      .click();

    await expect(page.getByText(/invitation cancelled/i)).toBeVisible();

    const preview = await page.request.get(inviteUrl.replace('http://localhost:3000', ''));
    expect(preview.status()).toBe(410);
  });

  test('refuses a second pending invitation to the same address', async ({
    page,
    request: apiRequest,
  }) => {
    const owner = await registerOwner(apiRequest);
    await useSession(page, owner.accessToken, owner.businessId);

    await page.goto('/settings/team');
    const invitee = `twice-${randomUUID()}@example.com`;
    await page.getByLabel(/email address/i).fill(invitee);
    await page.getByRole('button', { name: /send invitation/i }).click();
    await expect(page.locator('code')).toBeVisible();

    await page.getByLabel(/email address/i).fill(invitee.toUpperCase());
    await page.getByRole('button', { name: /send invitation/i }).click();

    await expect(page.getByText(/already has a pending invitation/i)).toBeVisible();
  });
});
