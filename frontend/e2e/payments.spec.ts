import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// E2E for the payments flow (spec 0010, AC-1 to AC-21).
// Requires the dev stack: backend on :4000 with RATE_LIMIT_DISABLED=true, frontend on :3000, PostgreSQL running.
// Run with: npm run e2e --workspace @f-commerce/frontend -- e2e/payments.spec.ts

test.use({ baseURL: 'http://localhost:3000' });

const password = 'Password123!';

interface SeededBusiness {
  token: string;
  businessId: string;
  ownerName: string;
  productId: string;
  productName: string;
  customerId: string;
  customerName: string;
}

async function seedBusiness(
  apiRequest: APIRequestContext,
  {
    currency = 'BDT',
    timezone = 'Asia/Dhaka',
    ownerName = 'Maya Owner',
  }: { currency?: 'BDT' | 'USD'; timezone?: string; ownerName?: string } = {},
): Promise<SeededBusiness> {
  const suffix = randomUUID().slice(0, 8);
  const email = `pay-e2e-${suffix}@example.com`;
  const registerRes = await apiRequest.post('/api/auth/register', {
    data: { email, password, name: ownerName, businessName: `Pay E2E ${suffix}` },
    headers: { Connection: 'close' },
  });
  expect(registerRes.ok()).toBe(true);
  const regJson = (await registerRes.json()) as { accessToken: string };
  const token = regJson.accessToken;
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString()) as {
    memberships?: { businessId?: string }[];
  };
  const businessId = payload.memberships?.[0]?.businessId ?? '';
  expect(businessId).toBeTruthy();

  const headers = {
    Authorization: `Bearer ${token}`,
    'x-business-id': businessId,
    Connection: 'close',
  };
  const onboardRes = await apiRequest.put('/api/business/onboarding', {
    data: {
      name: `Pay E2E ${suffix}`,
      currency,
      timezone,
      address: { street: '10 Market Rd', city: 'Dhaka', country: 'Bangladesh' },
    },
    headers,
  });
  expect(onboardRes.ok()).toBe(true);

  const catRes = await apiRequest.post('/api/categories', {
    data: { name: `E2E Wear ${suffix}` },
    headers,
  });
  expect(catRes.ok()).toBe(true);
  const categoryId = ((await catRes.json()) as { data: { id: string } }).data.id;

  const productName = `Silk Kurta ${suffix}`;
  const prodRes = await apiRequest.post('/api/products', {
    data: {
      name: productName,
      categoryId,
      sku: `SKU-${suffix}`,
      price: 1200,
      stockCount: 100,
    },
    headers,
  });
  expect(prodRes.ok()).toBe(true);
  const productId = ((await prodRes.json()) as { data: { id: string } }).data.id;

  const digits = randomUUID().replace(/\D/g, '').slice(0, 8).padStart(8, '9');
  const customerName = `Nadia Buyer ${suffix}`;
  const custRes = await apiRequest.post('/api/customers', {
    data: {
      name: customerName,
      phone: `+8801${digits}`,
      address: '42 Lake Rd\nDhaka',
    },
    headers,
  });
  expect(custRes.ok()).toBe(true);
  const customerId = ((await custRes.json()) as { data: { id: string } }).data.id;

  return { token, businessId, ownerName, productId, productName, customerId, customerName };
}

async function seedStaff(apiRequest: APIRequestContext, biz: SeededBusiness, staffName: string) {
  const suffix = randomUUID().slice(0, 8);
  const email = `staff-pay-${suffix}@example.com`;
  const headers = {
    Authorization: `Bearer ${biz.token}`,
    'x-business-id': biz.businessId,
    Connection: 'close',
  };
  const inviteRes = await apiRequest.post('/api/team/invitations', {
    data: { email, role: 'STAFF' },
    headers,
  });
  expect(inviteRes.ok()).toBe(true);
  const inviteUrl = ((await inviteRes.json()) as { data: { inviteUrl: string } }).data.inviteUrl;
  const inviteToken = new URL(inviteUrl).pathname.split('/').pop();
  expect(inviteToken).toBeTruthy();

  const acceptRes = await apiRequest.post(`/api/invitations/${inviteToken}/accept`, {
    data: { name: staffName, password },
    headers: { Connection: 'close' },
  });
  expect(acceptRes.ok()).toBe(true);
  const acceptJson = (await acceptRes.json()) as { data: { accessToken: string } };
  return { token: acceptJson.data.accessToken, businessId: biz.businessId, name: staffName };
}

async function setAuthState(page: Page, token: string, businessId: string) {
  await page.addInitScript(
    (auth) => {
      window.localStorage.setItem('accessToken', auth.token);
      window.localStorage.setItem('businessId', auth.businessId);
    },
    { token, businessId },
  );
}

async function pickCustomerAndProduct(page: Page, customerName: string, productName: string) {
  await page.getByRole('searchbox', { name: /find the customer/i }).fill(customerName);
  await page.getByRole('button', { name: new RegExp(customerName) }).click();
  await page.getByRole('searchbox', { name: /add a product/i }).fill(productName);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: productName })).toBeVisible();
}

test.describe('payments', () => {
  test('creates orders with first payments, records later payments, refunds, voids, and blocks edits below paid', async ({
    page,
    request: apiRequest,
  }) => {
    const biz = await seedBusiness(apiRequest, { currency: 'BDT', ownerName: 'Farhana Owner' });
    const headers = {
      Authorization: `Bearer ${biz.token}`,
      'x-business-id': biz.businessId,
      Connection: 'close',
    };
    await setAuthState(page, biz.token, biz.businessId);

    // 1. Create form validation, method label switching, CARD warning, Full amount, and blank save
    await page.goto('/orders/new');
    await pickCustomerAndProduct(page, biz.customerName, biz.productName);
    await expect(page.getByRole('heading', { name: 'Payment received' })).toBeVisible();
    await expect(page.locator('#order-payment-method')).toHaveValue('CASH');
    await expect(page.locator('label[for="order-payment-reference"]')).toHaveText(
      'Reference (optional)',
    );

    await page.locator('#order-payment-method').selectOption('BKASH');
    await expect(page.locator('label[for="order-payment-reference"]')).toHaveText(
      'Transaction ID (optional)',
    );
    await page.locator('#order-payment-method').selectOption('CARD');
    await expect(page.getByText(/Never enter a full card number/i)).toBeVisible();
    await page.locator('#order-payment-method').selectOption('CASH');
    await expect(page.getByText(/Never enter a full card number/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Full amount' }).click();
    await expect(page.locator('#order-payment-amount')).toHaveValue('1200');
    await page.locator('#order-payment-amount').fill('1201');
    await expect(page.getByText(/Amount cannot exceed the live total/i)).toBeVisible();
    await page.getByRole('button', { name: 'Create order' }).click();
    await expect(page.getByText('Check the highlighted fields.')).toBeVisible();
    await expect(page).toHaveURL(/\/orders\/new$/);

    await page.locator('#order-payment-amount').fill('');
    await page.getByRole('button', { name: 'Create order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
    await expect(page.getByText('No payments recorded yet')).toBeVisible();
    await expect(page.locator('main')).toContainText('Unpaid');

    // 2. Create partial order with 500 bKash advance, then confirm duplicate keeping same initial payment
    const dupCustRes = await apiRequest.post('/api/customers', {
      data: { name: 'Samira Advance', phone: '+8801722334499', address: '99 Gulshan Ave' },
      headers,
    });
    expect(dupCustRes.ok()).toBe(true);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await page.goto('/orders/new');
      await pickCustomerAndProduct(page, 'Samira Advance', biz.productName);
      await page.locator('#order-payment-amount').fill('500');
      await page.locator('#order-payment-method').selectOption('BKASH');
      await page.locator('#order-payment-reference').fill(`TRX-E2E-${attempt}`);
      await page.locator('#order-payment-notes').fill('Advance received');
      await page.getByRole('button', { name: 'Create order' }).click();
      if (attempt === 2) {
        await expect(
          page.getByRole('heading', { name: 'This looks like a duplicate' }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Create anyway' }).click();
      }
      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
      await expect(page.getByText(`TRX-E2E-${attempt}`)).toBeVisible();
      await expect(page.locator('main')).toContainText('Partial');
    }

    // 3. Record remaining 700 later on the second order -> Paid, hides Record payment, keeps timeline unchanged
    const timelineBefore = await page.locator('section:has(h2:text("Status timeline")) li').count();
    await page.getByRole('button', { name: 'Record payment' }).click();
    const payDialog = page.getByRole('dialog', { name: 'Record payment' });
    await expect(payDialog.locator('#record-payment-amount')).toHaveValue('700');
    await payDialog.getByRole('button', { name: 'Save payment' }).click();
    await expect(payDialog).toBeHidden();
    await expect(page.getByText('Payment recorded.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);
    await expect(page.locator('section:has(h2:text("Status timeline")) li')).toHaveCount(
      timelineBefore,
    );

    // 4. Create full Cash on delivery order -> immediately Paid
    const codCustRes = await apiRequest.post('/api/customers', {
      data: { name: 'Kamal COD', phone: '+8801733445599', address: '7 Dhanmondi' },
      headers,
    });
    expect(codCustRes.ok()).toBe(true);
    await page.goto('/orders/new');
    await pickCustomerAndProduct(page, 'Kamal COD', biz.productName);
    await page.getByRole('button', { name: 'Full amount' }).click();
    await page.locator('#order-payment-method').selectOption('CASH_ON_DELIVERY');
    await page.getByRole('button', { name: 'Create order' }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
    await expect(page.getByText('Cash on delivery')).toBeVisible();
    await expect(page.locator('main')).toContainText('Paid');

    // 5. Edit guard: lowering PENDING order total below 500 paid fails with refund/void guidance
    const editOrdRes = await apiRequest.post('/api/orders', {
      data: {
        customerId: biz.customerId,
        source: 'DIRECT',
        shippingAddress: '42 Lake Rd',
        items: [{ productId: biz.productId, quantity: 1, unitPrice: 1000 }],
        initialPayment: { amount: 500, method: 'CASH' },
        confirmDuplicate: true,
      },
      headers,
    });
    expect(editOrdRes.ok()).toBe(true);
    const editOrdId = ((await editOrdRes.json()) as { data: { id: string } }).data.id;

    await page.goto(`/orders/${editOrdId}`);
    await page.getByRole('button', { name: 'Edit order' }).click();
    await page.locator('input[id$="-price"]').first().fill('400');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByText(/Refund or void payments before lowering the order total/i),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: /Edit ORD-/ })).toBeVisible();

    // 6. Cancel partially paid order -> Refund owed 500 -> refund 200 then 300 -> Void on live entry
    const refundOrdRes = await apiRequest.post('/api/orders', {
      data: {
        customerId: biz.customerId,
        source: 'DIRECT',
        shippingAddress: '42 Lake Rd',
        items: [{ productId: biz.productId, quantity: 1, unitPrice: 1200 }],
        initialPayment: { amount: 500, method: 'BKASH' },
        confirmDuplicate: true,
      },
      headers,
    });
    expect(refundOrdRes.ok()).toBe(true);
    const refundOrdId = ((await refundOrdRes.json()) as { data: { id: string } }).data.id;

    await page.goto(`/orders/${refundOrdId}`);
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByText(/Order moved to Cancelled/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record payment' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Record refund' }).click();
    const refDlg = page.getByRole('dialog', { name: 'Record refund' });
    await expect(refDlg.locator('#record-payment-amount')).toHaveValue('500');
    await refDlg.locator('#record-payment-amount').fill('200');
    await refDlg.getByRole('button', { name: 'Save refund' }).click();
    await expect(refDlg).toBeHidden();

    await page.getByRole('button', { name: 'Record refund' }).click();
    await expect(page.getByRole('dialog').locator('#record-payment-amount')).toHaveValue('300');
    await page.getByRole('dialog').getByRole('button', { name: 'Save refund' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Record refund' })).toHaveCount(0);

    // Void the remaining 500 payment on editOrdId
    await page.goto(`/orders/${editOrdId}`);
    await page.getByRole('button', { name: /Void payment/i }).click();
    const voidDlg = page.getByRole('dialog', { name: /Void this payment\?/i });
    await voidDlg.locator('#void-payment-reason').fill('Wrong order matched');
    await voidDlg.getByRole('button', { name: 'Void entry' }).click();
    await expect(voidDlg).toBeHidden();
    await expect(page.getByText('Voided', { exact: true })).toBeVisible();
    await expect(page.getByText(/Voided by Farhana Owner: Wrong order matched/)).toBeVisible();
    await expect(page.getByText('Excluded from totals')).toBeVisible();
  });

  test('handles two-tab conflicts and enforces owner-only refund and void controls for staff', async ({
    browser,
    context,
    request: apiRequest,
  }) => {
    const biz = await seedBusiness(apiRequest, { currency: 'BDT', ownerName: 'Conflict Owner' });
    const headers = {
      Authorization: `Bearer ${biz.token}`,
      'x-business-id': biz.businessId,
      Connection: 'close',
    };
    await context.addInitScript(
      (auth) => {
        window.localStorage.setItem('accessToken', auth.token);
        window.localStorage.setItem('businessId', auth.businessId);
      },
      { token: biz.token, businessId: biz.businessId },
    );

    const closedRaceOrd = (
      (await (
        await apiRequest.post('/api/orders', {
          data: {
            customerId: biz.customerId,
            source: 'DIRECT',
            shippingAddress: '42 Lake Rd',
            items: [{ productId: biz.productId, quantity: 1, unitPrice: 1000 }],
            initialPayment: { amount: 400, method: 'CASH' },
            confirmDuplicate: true,
          },
          headers,
        })
      ).json()) as { data: { id: string } }
    ).data;

    const tab1 = await context.newPage();
    const tab2 = await context.newPage();
    await Promise.all([
      tab1.goto(`/orders/${closedRaceOrd.id}`),
      tab2.goto(`/orders/${closedRaceOrd.id}`),
    ]);

    await tab2.getByRole('button', { name: 'Record payment' }).click();
    await expect(tab2.getByRole('dialog', { name: 'Record payment' })).toBeVisible();

    await tab1.getByRole('button', { name: 'Cancel order' }).click();
    await tab1.getByRole('dialog').getByRole('button', { name: 'Cancel order' }).click();
    await expect(tab1.getByText(/Order moved to Cancelled/i)).toBeVisible();

    await tab2.getByRole('dialog').getByRole('button', { name: 'Save payment' }).click();
    await expect(tab2.getByRole('dialog')).toBeHidden();
    await expect(tab2.locator('main').getByRole('alert')).toBeVisible();
    await expect(tab2.getByText('Refund owed').first()).toBeVisible();

    // Two tabs exceeding remaining due: PAYMENT_EXCEEDS_DUE stays open and succeeds after lowering
    const dueRaceOrd = (
      (await (
        await apiRequest.post('/api/orders', {
          data: {
            customerId: biz.customerId,
            source: 'DIRECT',
            shippingAddress: '42 Lake Rd',
            items: [{ productId: biz.productId, quantity: 1, unitPrice: 500 }],
            confirmDuplicate: true,
          },
          headers,
        })
      ).json()) as { data: { id: string } }
    ).data;

    await Promise.all([
      tab1.goto(`/orders/${dueRaceOrd.id}`),
      tab2.goto(`/orders/${dueRaceOrd.id}`),
    ]);
    await tab1.getByRole('button', { name: 'Record payment' }).click();
    await tab2.getByRole('button', { name: 'Record payment' }).click();

    await tab1.getByRole('dialog').locator('#record-payment-amount').fill('400');
    await tab1.getByRole('dialog').getByRole('button', { name: 'Save payment' }).click();
    await expect(tab1.getByRole('dialog')).toBeHidden();

    const dlg2 = tab2.getByRole('dialog', { name: 'Record payment' });
    await dlg2.locator('#record-payment-amount').fill('400');
    await dlg2.getByRole('button', { name: 'Save payment' }).click();
    await expect(dlg2.getByText(/Current due is 100 BDT/i)).toBeVisible();
    await dlg2.locator('#record-payment-amount').fill('100');
    await dlg2.getByRole('button', { name: 'Save payment' }).click();
    await expect(dlg2).toBeHidden();
    await expect(tab2.getByText('Payment recorded.')).toBeVisible();

    // Two tabs voiding: PAYMENT_ALREADY_VOIDED closes & refreshes; VOID_BREAKS_BALANCE stays open
    const voidRaceOrd = (
      (await (
        await apiRequest.post('/api/orders', {
          data: {
            customerId: biz.customerId,
            source: 'DIRECT',
            shippingAddress: '42 Lake Rd',
            items: [{ productId: biz.productId, quantity: 1, unitPrice: 1000 }],
            initialPayment: { amount: 600, method: 'CASH' },
            confirmDuplicate: true,
          },
          headers,
        })
      ).json()) as { data: { id: string } }
    ).data;

    await Promise.all([
      tab1.goto(`/orders/${voidRaceOrd.id}`),
      tab2.goto(`/orders/${voidRaceOrd.id}`),
    ]);
    await tab1.getByRole('button', { name: /Void payment/i }).click();
    await tab2.getByRole('button', { name: /Void payment/i }).click();

    await tab1.getByRole('dialog').locator('#void-payment-reason').fill('First tab void');
    await tab1.getByRole('dialog').getByRole('button', { name: 'Void entry' }).click();
    await expect(tab1.getByRole('dialog')).toBeHidden();

    await tab2.getByRole('dialog').locator('#void-payment-reason').fill('Second tab void');
    await tab2.getByRole('dialog').getByRole('button', { name: 'Void entry' }).click();
    await expect(tab2.getByRole('dialog')).toBeHidden();
    await expect(tab2.locator('main').getByRole('alert')).toBeVisible();

    // Seed an order with 600 payment and 200 refund -> voiding 600 payment hits VOID_BREAKS_BALANCE
    const balOrd = (
      (await (
        await apiRequest.post('/api/orders', {
          data: {
            customerId: biz.customerId,
            source: 'DIRECT',
            shippingAddress: '42 Lake Rd',
            items: [{ productId: biz.productId, quantity: 1, unitPrice: 1000 }],
            initialPayment: { amount: 600, method: 'CASH' },
            confirmDuplicate: true,
          },
          headers,
        })
      ).json()) as { data: { id: string } }
    ).data;
    await apiRequest.post(`/api/orders/${balOrd.id}/refunds`, {
      data: { amount: 200, method: 'CASH' },
      headers,
    });

    await tab1.goto(`/orders/${balOrd.id}`);
    await tab1.getByRole('button', { name: /Void payment of 600 BDT/i }).click();
    const balVoidDlg = tab1.getByRole('dialog', { name: 'Void this payment?' });
    await balVoidDlg.locator('#void-payment-reason').fill('Break balance');
    await balVoidDlg.getByRole('button', { name: 'Void entry' }).click();
    await expect(balVoidDlg.getByRole('alert')).toBeVisible();
    await balVoidDlg.getByRole('button', { name: 'Keep entry' }).click();
    await expect(balVoidDlg).toBeHidden();
    await tab1.close();
    await tab2.close();

    // STAFF context: Record payment visible & working; Record refund and Void absent; /payments reachable
    const staff = await seedStaff(apiRequest, biz, 'Tariq Staff');
    const staffContext = await browser.newContext();
    await staffContext.addInitScript(
      (auth) => {
        window.localStorage.setItem('accessToken', auth.token);
        window.localStorage.setItem('businessId', auth.businessId);
      },
      { token: staff.token, businessId: staff.businessId },
    );
    const staffPage = await staffContext.newPage();
    await staffPage.goto(`/orders/${balOrd.id}`);
    await expect(staffPage.getByRole('button', { name: 'Record payment' })).toBeVisible();
    await expect(staffPage.getByRole('button', { name: 'Record refund' })).toHaveCount(0);
    await expect(staffPage.getByRole('button', { name: /^Void/ })).toHaveCount(0);

    await staffPage.getByRole('button', { name: 'Record payment' }).click();
    await staffPage.getByRole('dialog').locator('#record-payment-amount').fill('100');
    await staffPage.getByRole('dialog').getByRole('button', { name: 'Save payment' }).click();
    await expect(staffPage.getByRole('dialog')).toBeHidden();
    await expect(staffPage.getByText('Recorded by Tariq Staff')).toBeVisible();
    await staffContext.close();
  });

  test('filters orders by payment status, runs the payments ledger across viewports, switches currency, and updates customer totals', async ({
    page,
    isMobile,
    request: apiRequest,
  }) => {
    // 1. Orders list payment badges, payment filter chips, AND search/status, Load more
    const filterBiz = await seedBusiness(apiRequest, {
      currency: 'BDT',
      ownerName: 'Filter Owner',
    });
    const fHeaders = {
      Authorization: `Bearer ${filterBiz.token}`,
      'x-business-id': filterBiz.businessId,
      Connection: 'close',
    };

    const specialCustRes = await apiRequest.post('/api/customers', {
      data: { name: 'Zara Special', phone: '+8801799887755', address: '1 Special St' },
      headers: fHeaders,
    });
    expect(specialCustRes.ok()).toBe(true);
    const specialCustId = ((await specialCustRes.json()) as { data: { id: string } }).data.id;

    for (let i = 0; i < 21; i += 1) {
      const ord = (
        (await (
          await apiRequest.post('/api/orders', {
            data: {
              customerId: filterBiz.customerId,
              source: 'DIRECT',
              shippingAddress: '42 Lake Rd',
              items: [{ productId: filterBiz.productId, quantity: 1, unitPrice: 1000 }],
              confirmDuplicate: true,
            },
            headers: fHeaders,
          })
        ).json()) as { data: { id: string; version: number } }
      ).data;
      if (i === 0) {
        await apiRequest.post(`/api/orders/${ord.id}/payments`, {
          data: { amount: 400, method: 'CASH' },
          headers: fHeaders,
        });
      } else if (i === 1) {
        await apiRequest.post(`/api/orders/${ord.id}/payments`, {
          data: { amount: 1000, method: 'CASH' },
          headers: fHeaders,
        });
      } else if (i === 2) {
        await apiRequest.post(`/api/orders/${ord.id}/payments`, {
          data: { amount: 300, method: 'CASH' },
          headers: fHeaders,
        });
        await apiRequest.post(`/api/orders/${ord.id}/status`, {
          data: { status: 'CANCELLED', version: ord.version },
          headers: fHeaders,
        });
      }
    }

    const specialOrd = (
      (await (
        await apiRequest.post('/api/orders', {
          data: {
            customerId: specialCustId,
            source: 'DIRECT',
            shippingAddress: '1 Special St',
            items: [{ productId: filterBiz.productId, quantity: 1, unitPrice: 1200 }],
            initialPayment: { amount: 200, method: 'BKASH' },
            confirmDuplicate: true,
          },
          headers: fHeaders,
        })
      ).json()) as { data: { id: string; version: number } }
    ).data;
    await apiRequest.post(`/api/orders/${specialOrd.id}/status`, {
      data: { status: 'CONFIRMED', version: specialOrd.version },
      headers: fHeaders,
    });

    await setAuthState(page, filterBiz.token, filterBiz.businessId);
    await page.goto('/orders');

    const visibleOrders = isMobile ? page.locator('main article') : page.locator('tbody tr');
    await expect(visibleOrders.first()).toBeVisible();
    await expect(visibleOrders).toHaveCount(20);

    await page.getByRole('button', { name: /Load more/i }).click();
    await expect(visibleOrders).toHaveCount(21);

    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('button', { name: 'Refund owed', exact: true }).click();
    await expect(visibleOrders).toHaveCount(1);

    await page.getByRole('button', { name: 'Confirmed', exact: true }).click();
    await page.getByRole('button', { name: 'Has due', exact: true }).click();
    await page.getByRole('searchbox').fill('Zara Special');
    await expect(visibleOrders).toHaveCount(1);
    await expect(visibleOrders.first()).toContainText('Zara Special');
    await expect(visibleOrders.first()).toContainText('Partial');

    // 2. Payments ledger page across desktop sidebar and phone More sheet (5 mobile bottom slots)
    const ledBiz = await seedBusiness(apiRequest, { currency: 'BDT', ownerName: 'Ledger Owner' });
    const lHeaders = {
      Authorization: `Bearer ${ledBiz.token}`,
      'x-business-id': ledBiz.businessId,
      Connection: 'close',
    };
    const ledOrd = (
      (await (
        await apiRequest.post('/api/orders', {
          data: {
            customerId: ledBiz.customerId,
            source: 'DIRECT',
            shippingAddress: '42 Lake Rd',
            items: [{ productId: ledBiz.productId, quantity: 10, unitPrice: 1000 }],
            confirmDuplicate: true,
          },
          headers: lHeaders,
        })
      ).json()) as { data: { id: string } }
    ).data;

    for (let i = 0; i < 20; i += 1) {
      await apiRequest.post(`/api/orders/${ledOrd.id}/payments`, {
        data: { amount: 100, method: i % 2 === 0 ? 'BKASH' : 'CASH', referenceNumber: `REF-${i}` },
        headers: lHeaders,
      });
    }
    const voidTargetRes = await apiRequest.post(`/api/orders/${ledOrd.id}/payments`, {
      data: { amount: 500, method: 'NAGAD', referenceNumber: 'VOID-LEDGER' },
      headers: lHeaders,
    });
    const toVoid = (
      (await voidTargetRes.json()) as {
        data: { payments: { id: string; referenceNumber: string | null }[] };
      }
    ).data.payments.find((entry) => entry.referenceNumber === 'VOID-LEDGER');
    expect(toVoid).toBeTruthy();
    await apiRequest.post(`/api/orders/${ledOrd.id}/payments/${toVoid?.id}/void`, {
      data: { reason: 'Entered twice' },
      headers: lHeaders,
    });
    await apiRequest.post(`/api/orders/${ledOrd.id}/refunds`, {
      data: { amount: 300, method: 'CASH' },
      headers: lHeaders,
    });

    await page.addInitScript(
      (auth) => {
        window.localStorage.setItem('accessToken', auth.token);
        window.localStorage.setItem('businessId', auth.businessId);
      },
      { token: ledBiz.token, businessId: ledBiz.businessId },
    );
    await page.goto('/orders');

    if (isMobile) {
      const mobileNav = page.locator('nav[aria-label="Mobile navigation"]');
      await expect(mobileNav).toBeVisible();
      await expect(mobileNav.locator('> a, > button')).toHaveCount(5);
      await mobileNav.getByRole('button', { name: 'More' }).click();
      await page
        .getByRole('navigation', { name: 'Secondary navigation' })
        .getByRole('link', { name: 'Payments' })
        .click();
    } else {
      await page
        .getByRole('navigation', { name: 'Primary navigation' })
        .getByRole('link', { name: 'Payments' })
        .click();
    }

    await expect(page).toHaveURL(/\/payments$/);
    await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();

    const ledgerRows = isMobile ? page.locator('main article') : page.locator('tbody tr');
    await expect(ledgerRows).toHaveCount(20);
    await expect(page.locator('section[aria-label="Payment totals"]')).toContainText('2,000 BDT');
    await expect(page.locator('section[aria-label="Payment totals"]')).toContainText('300 BDT');
    await expect(page.locator('section[aria-label="Payment totals"]')).toContainText('1,700 BDT');
    await expect(
      page.getByText('Voided', { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Load more payments' }).click();
    await expect(ledgerRows).toHaveCount(22);

    await page.locator('#payments-method').selectOption('PAYPAL');
    await expect(page.getByText('No payments match these filters')).toBeVisible();
    await page.getByRole('button', { name: 'Reset filters' }).first().click();
    await expect(ledgerRows.first()).toBeVisible();

    await page.locator('#payments-from').fill('2026-12-25');
    await page.locator('#payments-to').fill('2026-12-01');
    await expect(page.getByText('Start date must be on or before end date.')).toBeVisible();
    await page.getByRole('button', { name: 'Reset filters' }).first().click();
    await expect(ledgerRows.first()).toBeVisible();

    // 3. Switch currency BDT -> USD and check write selects vs historical bKash vs /payments filter
    await page.goto('/settings');
    await page.locator('#currency').selectOption('USD');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Profile updated')).toBeVisible();

    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Create order' })).toBeVisible();
    await expect(page.locator('#order-payment-method option')).not.toHaveCount(0);
    const usdCreateOptions = await page
      .locator('#order-payment-method option')
      .evaluateAll((opts) => opts.map((opt) => (opt as HTMLOptionElement).value));
    expect(usdCreateOptions).not.toContain('BKASH');
    expect(usdCreateOptions).not.toContain('NAGAD');

    await page.goto(`/orders/${ledOrd.id}`);
    await expect(page.locator('main')).toContainText('bKash');
    await expect(page.locator('main')).toContainText('USD');

    await page.goto('/payments');
    await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    await expect(page.locator('#payments-method option')).not.toHaveCount(0);
    const ledgerFilterOptions = await page
      .locator('#payments-method option')
      .evaluateAll((opts) => opts.map((opt) => (opt as HTMLOptionElement).value));
    expect(ledgerFilterOptions).toContain('BKASH');
    expect(ledgerFilterOptions).toContain('NAGAD');

    // 4. Customer profile Total spent vs Total due (cancelled order contributes 0 due)
    const cancelOrd = (
      (await (
        await apiRequest.post('/api/orders', {
          data: {
            customerId: ledBiz.customerId,
            source: 'DIRECT',
            shippingAddress: '42 Lake Rd',
            items: [{ productId: ledBiz.productId, quantity: 1, unitPrice: 800 }],
            initialPayment: { amount: 300, method: 'CASH' },
            confirmDuplicate: true,
          },
          headers: lHeaders,
        })
      ).json()) as { data: { id: string; version: number } }
    ).data;
    await apiRequest.post(`/api/orders/${cancelOrd.id}/status`, {
      data: { status: 'CANCELLED', version: cancelOrd.version },
      headers: lHeaders,
    });

    await page.goto(`/customers/${ledBiz.customerId}`);
    await expect(page.getByText('Total spent')).toBeVisible();
    await expect(page.locator('main')).toContainText('10,000 USD');
    await expect(page.locator('main')).toContainText('8,300 USD');
  });
});
