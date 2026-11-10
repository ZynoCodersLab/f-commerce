import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// E2E for team and staff invites (spec 0009).
// Requires the dev stack: backend on :4000, frontend on :3000, PostgreSQL running.
// Covers AC-1, AC-5, AC-6, AC-7, AC-8, AC-11, AC-13, AC-21.
// Run with: npm run e2e --workspace @f-commerce/frontend

test.use({ baseURL: 'http://localhost:3000' });

const password = 'password123';

interface Session {
  accessToken: string;
  businessId: string;
}

async function registerAccount(
  apiRequest: APIRequestContext,
  input: { email: string; name: string; businessName: string },
): Promise<Session> {
  const response = await apiRequest.post('/api/auth/register', {
    data: { ...input, password },
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

/** The token in the invite link also addresses the public preview endpoint. */
function previewPath(inviteUrl: string): string {
  return new URL(inviteUrl).pathname.replace('/invite/', '/api/invitations/');
}

/** The one time link is the only code block labelled as the invitation link. */
function inviteLink(page: Page) {
  return page.locator('code[aria-label="Invitation link"]');
}

test.describe('team and staff invites', () => {
  test('invites, shows the one time link, and sends the invitee through it', async ({
    page,
    browser,
    request: apiRequest,
  }) => {
    const owner = await registerAccount(apiRequest, {
      email: `owner-${randomUUID()}@example.com`,
      name: 'Maya Owner',
      businessName: `Threads ${randomUUID()}`,
    });
    await useSession(page, owner.accessToken, owner.businessId);

    await page.goto('/settings/team');
    await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
    // Desktop renders a table row and mobile renders a card, so ask for the
    // visible copy rather than the first match in the DOM.
    await expect(page.getByText('Maya Owner').filter({ visible: true }).first()).toBeVisible();

    const invitee = `staff-${randomUUID()}@example.com`;
    await page.getByLabel(/email address/i).fill(invitee);
    await page.getByRole('button', { name: /send invitation/i }).click();

    const link = inviteLink(page);
    await expect(link).toContainText('/invite/');
    const inviteUrl = (await link.textContent())?.trim() ?? '';
    expect(inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);

    // The invitee is listed with a status word, not just a colour.
    await expect(page.getByText(invitee).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText(/not emailed|sending|email sent/i).first()).toBeVisible();

    // The public page describes the invitation before asking for a password.
    // A fresh context keeps the owner's session out of the invitee's browser.
    const inviteContext = await browser.newContext();
    const invitePage = await inviteContext.newPage();
    await invitePage.goto(inviteUrl);
    await expect(invitePage.getByText(/invited you to join/i)).toBeVisible();
    // The address is shown in the sentence and again in the details list.
    await expect(invitePage.getByText(invitee).first()).toBeVisible();
    await expect(invitePage.getByRole('heading', { level: 1 })).toBeVisible();

    await invitePage.getByLabel(/your name/i).fill('Sam Staff');
    // Set-password mode renders two password inputs, so match each by its exact
    // label: the loose /password/i matcher resolves to both and aborts.
    await invitePage.getByLabel('Password', { exact: true }).fill(password);
    await invitePage.getByLabel('Confirm password', { exact: true }).fill(password);
    await invitePage.getByRole('button', { name: /^join /i }).click();

    await invitePage.waitForURL('**/dashboard');
    await expect(
      invitePage.getByRole('heading', { name: /good (morning|afternoon|evening)/i }),
    ).toBeVisible();
    await inviteContext.close();

    // The new member now appears for the owner.
    await page.reload();
    await expect(page.getByText('Sam Staff').filter({ visible: true }).first()).toBeVisible();

    // The used link is politely refused by the preview the page reads.
    const reused = await apiRequest.get(previewPath(inviteUrl));
    expect([409, 410]).toContain(reused.status());
  });

  test('cancels a pending invitation so its link stops working', async ({
    page,
    request: apiRequest,
  }) => {
    const owner = await registerAccount(apiRequest, {
      email: `owner-${randomUUID()}@example.com`,
      name: 'Maya Owner',
      businessName: `Threads ${randomUUID()}`,
    });
    await useSession(page, owner.accessToken, owner.businessId);

    await page.goto('/settings/team');
    const invitee = `cancel-${randomUUID()}@example.com`;
    await page.getByLabel(/email address/i).fill(invitee);
    await page.getByRole('button', { name: /send invitation/i }).click();
    const inviteUrl = (await inviteLink(page).textContent())?.trim() ?? '';

    // One open invitation means one Cancel action, in a table row on desktop
    // and in a record card on mobile.
    await page
      .getByRole('button', { name: /^cancel$/i })
      .filter({ visible: true })
      .first()
      .click();
    await page
      .getByRole('dialog', { name: /cancel this invitation/i })
      .getByRole('button', {
        name: /cancel invitation/i,
      })
      .click();

    await expect(page.getByText(/invitation cancelled/i)).toBeVisible();

    const preview = await apiRequest.get(previewPath(inviteUrl));
    expect(preview.status()).toBe(410);
  });

  test('refuses a second pending invitation to the same address', async ({
    page,
    request: apiRequest,
  }) => {
    const owner = await registerAccount(apiRequest, {
      email: `owner-${randomUUID()}@example.com`,
      name: 'Maya Owner',
      businessName: `Threads ${randomUUID()}`,
    });
    await useSession(page, owner.accessToken, owner.businessId);

    await page.goto('/settings/team');
    const invitee = `twice-${randomUUID()}@example.com`;
    await page.getByLabel(/email address/i).fill(invitee);
    await page.getByRole('button', { name: /send invitation/i }).click();
    await expect(inviteLink(page)).toBeVisible();

    await page.getByLabel(/email address/i).fill(invitee.toUpperCase());
    await page.getByRole('button', { name: /send invitation/i }).click();

    await expect(page.getByText(/already has a pending invitation/i)).toBeVisible();
  });

  test('lets a signed in account accept the link without leaving the page', async ({
    page,
    request: apiRequest,
  }) => {
    const owner = await registerAccount(apiRequest, {
      email: `owner-${randomUUID()}@example.com`,
      name: 'Maya Owner',
      businessName: `Threads ${randomUUID()}`,
    });
    const invitee = `signed-in-${randomUUID()}@example.com`;
    const created = await apiRequest.post('/api/team/invitations', {
      headers: {
        Authorization: `Bearer ${owner.accessToken}`,
        'X-Business-Id': owner.businessId,
      },
      data: { email: invitee },
    });
    expect(created.status()).toBe(201);
    const body = (await created.json()) as { data: { inviteUrl: string } };

    // The invitee already has an account and a business of their own.
    const inviteeAccount = await registerAccount(apiRequest, {
      email: invitee,
      name: 'Sam Staff',
      businessName: `Sam Shop ${randomUUID()}`,
    });
    await useSession(page, inviteeAccount.accessToken, inviteeAccount.businessId);

    await page.goto(body.data.inviteUrl);
    await expect(page.getByRole('heading', { name: /^join /i })).toBeVisible();
    await expect(page.getByText(/signed in as/i)).toBeVisible();
    // The page keeps its place instead of bouncing a signed in visitor away.
    expect(new URL(page.url()).pathname.startsWith('/invite/')).toBe(true);
    await expect(page.getByLabel(/your name/i)).toHaveCount(0);
    // A signed in account accepts with its session alone (AC-8), so no password
    // is asked for and none is sent.
    await expect(page.getByLabel(/password/i)).toHaveCount(0);

    await page.getByRole('button', { name: /^join /i }).click();
    await page.waitForURL('**/dashboard');

    // The session now points at the business that invited them.
    expect(await page.evaluate(() => window.localStorage.getItem('businessId'))).toBe(
      owner.businessId,
    );
  });
});
