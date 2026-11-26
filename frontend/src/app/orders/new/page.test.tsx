import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test-utils/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerDto, OrderDto, ProductDto } from '@f-commerce/contracts';

import { ThemeBoundary } from '@/components/theme/theme';
import { setAuth } from '@/lib/auth-client';

const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/orders/new',
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
}));

import NewOrderPage from './page';

const created = '2026-10-20T10:00:00.000Z';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';

const customer: CustomerDto = {
  id: CUSTOMER_ID,
  name: 'Nusrat Jahan',
  phone: '+8801712345678',
  email: null,
  address: '12 Lake Road',
  notes: null,
  archivedAt: null,
  version: 1,
  createdAt: created,
  updatedAt: created,
};

const product: ProductDto = {
  id: PRODUCT_ID,
  name: 'Cotton shirt',
  description: null,
  categoryId: 'category-1',
  categoryName: 'Tops',
  sku: 'SHIRT-1',
  price: 2500,
  cost: 1500,
  stockCount: 10,
  lowStockThreshold: 2,
  availableStock: 10,
  stockStatus: 'inStock',
  images: [],
  options: [],
  variants: [],
  isArchived: false,
  archivedAt: null,
  version: 1,
  createdAt: created,
  updatedAt: created,
};

function makeOrder(overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    id: 'order-1',
    orderNumber: 'ORD-0001',
    status: 'PENDING',
    source: 'DIRECT',
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    shippingAddress: customer.address,
    notes: null,
    deliveryDeadline: null,
    subtotal: 5000,
    deliveryFee: 100,
    discount: 50,
    total: 5050,
    paidAmount: 0,
    dueAmount: 5050,
    refundOwed: 0,
    paymentStatus: 'UNPAID',
    version: 1,
    createdAt: created,
    updatedAt: created,
    items: [
      {
        id: 'line-1',
        productId: product.id,
        variantId: null,
        productName: product.name,
        variantLabel: null,
        price: product.price,
        cost: 1500,
        quantity: 2,
        subtotal: 5000,
        position: 0,
      },
    ],
    history: [
      {
        id: 'history-1',
        fromStatus: null,
        toStatus: 'PENDING',
        note: null,
        changedByName: 'Maya Owner',
        createdAt: created,
      },
    ],
    payments: [],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type HandlerResult = Response | Promise<Response> | undefined;

function installedFetch(
  handler: (url: string, init?: RequestInit) => HandlerResult,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      handler(String(input), init) ??
        jsonResponse(404, { error: 'NOT_FOUND', message: 'Not found' }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function metadata(url: string): Response | undefined {
  if (url === '/api/business/me') {
    return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
  }
  return undefined;
}

function renderPage() {
  return render(
    <ThemeBoundary>
      <NewOrderPage />
    </ThemeBoundary>,
  );
}

async function chooseCustomerAndProduct(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Find the customer'), 'Nusrat');
  await user.click(await screen.findByRole('button', { name: /Nusrat Jahan/ }));
  expect(await screen.findByLabelText('Shipping address')).toHaveValue('12 Lake Road');

  await user.type(screen.getByLabelText('Add a product'), 'Cotton');
  await user.click(await screen.findByRole('button', { name: 'Add' }));
  expect(await screen.findByRole('heading', { name: 'Cotton shirt' })).toBeVisible();
}

describe('NewOrderPage', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('creates an order from a customer, a product, and the totals', async () => {
    const user = userEvent.setup();
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders' && init?.method === 'POST') {
        return jsonResponse(201, { success: true, data: makeOrder() });
      }
      if (url.startsWith('/api/customers?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [customer], nextCursor: null },
        });
      }
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [product], nextCursor: null },
        });
      }
      return metadata(url);
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Create order' })).toBeVisible();
    await chooseCustomerAndProduct(user);

    await user.clear(screen.getByLabelText('Quantity'));
    await user.type(screen.getByLabelText('Quantity'), '2');
    await user.type(screen.getByLabelText('Delivery fee'), '100');
    await user.type(screen.getByLabelText('Discount'), '50');

    expect(screen.getByText('5,050 BDT')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/orders/order-1'));

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/orders' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const init = postCall?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({
      customerId: customer.id,
      items: [{ productId: product.id, variantId: null, quantity: 2 }],
      source: 'DIRECT',
      deliveryFee: 100,
      discount: 50,
      shippingAddress: '12 Lake Road',
      notes: null,
      deliveryDeadline: null,
      confirmDuplicate: false,
    });
  });

  // covers AC-15 and AC-19: a past promise warns but still saves the chosen day
  it('warns about a past deadline without blocking the save', async () => {
    const user = userEvent.setup();
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders' && init?.method === 'POST') {
        return jsonResponse(201, {
          success: true,
          data: makeOrder({ deliveryDeadline: '2020-01-01' }),
        });
      }
      if (url.startsWith('/api/customers?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [customer], nextCursor: null },
        });
      }
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [product], nextCursor: null },
        });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Create order' });
    await chooseCustomerAndProduct(user);

    fireEvent.change(screen.getByLabelText('Delivery deadline'), {
      target: { value: '2020-01-01' },
    });

    expect(
      screen.getByText('This date has already passed. You can still save the order.'),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/orders/order-1'));

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/orders' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(String((postCall?.[1] as RequestInit).body))).toMatchObject({
      deliveryDeadline: '2020-01-01',
    });
  });

  // covers AC-9: the warning compares the promise with the business day, not the browser day.
  it('compares a past deadline with the business day, not the browser day', async () => {
    // 02:00 UTC on 25 October is still 24 October in New York.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T02:00:00.000Z'));

    installedFetch((url) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, {
          success: true,
          data: { currency: 'BDT', timezone: 'America/New_York' },
        });
      }
      return undefined;
    });

    renderPage();

    await screen.findByRole('heading', { name: 'Create order' });
    // The badge renders twice, once in the sidebar and once in the mobile header.
    expect(
      await within(screen.getByRole('complementary', { name: 'Sidebar' })).findByText(
        'America/New_York · BDT',
      ),
    ).toBeVisible();

    const deadline = screen.getByLabelText('Delivery deadline');
    const warning = () =>
      screen.queryByText('This date has already passed. You can still save the order.');

    // 24 October is today in New York, so the promise is not late.
    fireEvent.change(deadline, { target: { value: '2026-10-24' } });
    expect(warning()).toBeNull();

    // 23 October is yesterday in New York, so the warning appears.
    fireEvent.change(deadline, { target: { value: '2026-10-23' } });
    expect(warning()).toBeVisible();
  });

  it('warns about a duplicate and reuses the same idempotency key when confirmed', async () => {
    const user = userEvent.setup();
    let posts = 0;
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders' && init?.method === 'POST') {
        posts += 1;
        if (posts === 1) {
          return jsonResponse(409, {
            error: 'DUPLICATE_ORDER',
            message: 'A matching order already exists.',
            existingOrder: {
              id: 'order-9',
              orderNumber: 'ORD-0009',
              status: 'PENDING',
              total: 5000,
              createdAt: created,
            },
          });
        }
        return jsonResponse(201, { success: true, data: makeOrder() });
      }
      if (url.startsWith('/api/customers?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [customer], nextCursor: null },
        });
      }
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [product], nextCursor: null },
        });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Create order' });
    await chooseCustomerAndProduct(user);

    await user.click(screen.getByRole('button', { name: 'Create order' }));

    const dialog = await screen.findByRole('dialog', { name: 'This looks like a duplicate' });
    expect(within(dialog).getByText('ORD-0009')).toBeVisible();
    expect(within(dialog).getByRole('link', { name: 'View existing order' })).toHaveAttribute(
      'href',
      '/orders/order-9',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Create anyway' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/orders/order-1'));

    const postCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input) === '/api/orders' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCalls).toHaveLength(2);
    const firstBody = JSON.parse(String((postCalls[0][1] as RequestInit).body)) as {
      confirmDuplicate: boolean;
    };
    const secondBody = JSON.parse(String((postCalls[1][1] as RequestInit).body)) as {
      confirmDuplicate: boolean;
    };
    expect(firstBody.confirmDuplicate).toBe(false);
    expect(secondBody.confirmDuplicate).toBe(true);
    expect(new Headers((postCalls[0][1] as RequestInit).headers).get('Idempotency-Key')).toBe(
      new Headers((postCalls[1][1] as RequestInit).headers).get('Idempotency-Key'),
    );
  });

  it('blocks submission until a customer and an item are chosen', async () => {
    const user = userEvent.setup();
    const fetchMock = installedFetch((url) => metadata(url));

    renderPage();
    await screen.findByRole('heading', { name: 'Create order' });

    await user.click(screen.getByRole('button', { name: 'Create order' }));

    const alerts = await screen.findAllByRole('alert');
    const text = alerts.map((alert) => alert.textContent).join(' ');
    expect(text).toContain('Choose an active customer.');
    expect(text).toContain('Add at least one product line with a valid quantity and price.');
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === '/api/orders' && (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  // covers AC-1, AC-18: first payment at create fills full amount, validates against live total, and submits initialPayment.
  it('fills full amount, updates method labels/warnings, blocks amounts above total, and submits initialPayment', async () => {
    const user = userEvent.setup();
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders' && init?.method === 'POST') {
        return jsonResponse(201, {
          success: true,
          data: makeOrder({ paidAmount: 2500, dueAmount: 0 }),
        });
      }
      if (url.startsWith('/api/customers?')) {
        return jsonResponse(200, { success: true, data: { items: [customer], nextCursor: null } });
      }
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, { success: true, data: { items: [product], nextCursor: null } });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Create order' });
    await chooseCustomerAndProduct(user);

    // Amount above the 2500 total shows an inline error and blocks save.
    const amountField = screen.getByLabelText('Amount received');
    await user.type(amountField, '3000');
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    expect(
      await screen.findByText(/Amount cannot exceed the live total of 2,500 BDT/),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === '/api/orders' && (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);

    // Full amount button sets 2500.
    await user.click(screen.getByRole('button', { name: 'Full amount' }));
    expect(amountField).toHaveValue(2500);

    // Method switches reference label and shows card reminder.
    const methodSelect = screen.getByLabelText('Payment method');
    await user.selectOptions(methodSelect, 'BKASH');
    expect(screen.getByLabelText('Transaction ID (optional)')).toBeVisible();

    await user.selectOptions(methodSelect, 'CARD');
    expect(screen.getByText(/Never enter a full card number/)).toBeVisible();

    await user.selectOptions(methodSelect, 'CASH_ON_DELIVERY');
    await user.type(screen.getByLabelText('Reference (optional)'), 'COD-1');
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/orders/order-1'));
    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/orders' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((postCall?.[1] as RequestInit).body))).toMatchObject({
      initialPayment: {
        amount: 2500,
        method: 'CASH_ON_DELIVERY',
        referenceNumber: 'COD-1',
        notes: null,
      },
    });
  });

  // covers AC-13, AC-18: hides bKash/Nagad for non-BDT businesses and preserves initialPayment on duplicate confirm.
  it('hides Bangladesh mobile methods for USD businesses and keeps initialPayment when confirming a duplicate', async () => {
    const user = userEvent.setup();
    let posts = 0;
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, {
          success: true,
          data: { currency: 'USD', timezone: 'America/New_York' },
        });
      }
      if (url === '/api/orders' && init?.method === 'POST') {
        posts += 1;
        if (posts === 1) {
          return jsonResponse(409, {
            error: 'DUPLICATE_ORDER',
            message: 'A matching order already exists.',
            existingOrder: {
              id: 'order-9',
              orderNumber: 'ORD-0009',
              status: 'PENDING',
              total: 2500,
              createdAt: created,
            },
          });
        }
        return jsonResponse(201, { success: true, data: makeOrder() });
      }
      if (url.startsWith('/api/customers?')) {
        return jsonResponse(200, { success: true, data: { items: [customer], nextCursor: null } });
      }
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, { success: true, data: { items: [product], nextCursor: null } });
      }
      return undefined;
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Create order' });
    await chooseCustomerAndProduct(user);

    const methodSelect = screen.getByLabelText('Payment method');
    await waitFor(() => {
      const optionValues = Array.from(methodSelect.querySelectorAll('option')).map((o) =>
        o.getAttribute('value'),
      );
      expect(optionValues).not.toContain('BKASH');
      expect(optionValues).not.toContain('NAGAD');
    });

    await user.type(screen.getByLabelText('Amount received'), '500');
    await user.click(screen.getByRole('button', { name: 'Create order' }));

    const dialog = await screen.findByRole('dialog', { name: 'This looks like a duplicate' });
    await user.click(within(dialog).getByRole('button', { name: 'Create anyway' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/orders/order-1'));
    const postCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input) === '/api/orders' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCalls).toHaveLength(2);
    expect(JSON.parse(String((postCalls[1][1] as RequestInit).body))).toMatchObject({
      confirmDuplicate: true,
      initialPayment: expect.objectContaining({ amount: 500, method: 'CASH' }),
    });
  });
});
