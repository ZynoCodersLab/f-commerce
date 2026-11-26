import { screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test-utils/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDto, OrderStatusType } from '@f-commerce/contracts';

import { ThemeBoundary } from '@/components/theme/theme';
import { setAuth } from '@/lib/auth-client';

const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/orders/order-1',
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useParams: () => ({ id: 'order-1' }),
}));

import OrderDetailPage from './page';

const created = '2026-10-20T10:00:00.000Z';
const updated = '2026-10-21T11:00:00.000Z';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const LINE_ID = '44444444-4444-4444-8444-444444444444';

function makeOrder(overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    id: 'order-1',
    orderNumber: 'ORD-0001',
    status: 'PENDING',
    source: 'FACEBOOK',
    customerId: CUSTOMER_ID,
    customerName: 'Nusrat Jahan',
    customerPhone: '+8801712345678',
    shippingAddress: '12 Lake Road',
    notes: 'Call first',
    deliveryDeadline: '2026-11-05',
    subtotal: 7500,
    deliveryFee: 100,
    discount: 50,
    total: 7550,
    paidAmount: 0,
    dueAmount: 7550,
    refundOwed: 0,
    paymentStatus: 'UNPAID',
    version: 1,
    createdAt: created,
    updatedAt: created,
    items: [
      {
        id: LINE_ID,
        productId: PRODUCT_ID,
        variantId: null,
        productName: 'Cotton shirt',
        variantLabel: null,
        price: 2500,
        cost: 1500,
        quantity: 3,
        subtotal: 7500,
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

function historyEntry(
  status: OrderStatusType,
  fromStatus: OrderStatusType | null,
  note: string | null = null,
) {
  return {
    id: `history-${status}`,
    fromStatus,
    toStatus: status,
    note,
    changedByName: 'Maya Owner',
    createdAt: updated,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installedFetch(
  handler: (url: string, init?: RequestInit) => Response | undefined,
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
      <OrderDetailPage />
    </ThemeBoundary>,
  );
}

describe('OrderDetailPage', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the order, items, totals, and status timeline', async () => {
    installedFetch((url) => {
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: makeOrder() });
      }
      return metadata(url);
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'ORD-0001' })).toBeVisible();
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Nusrat Jahan').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /\+8801712345678/ })).toHaveAttribute(
      'href',
      'tel:+8801712345678',
    );
    expect(screen.getAllByText('Cotton shirt').length).toBeGreaterThan(0);
    expect(screen.getAllByText('7,550 BDT').length).toBeGreaterThan(0);
    expect(screen.getByText('12 Lake Road')).toBeVisible();
    expect(screen.getByText('Call first')).toBeVisible();
    expect(screen.getByText('Created as Pending')).toBeVisible();
    expect(screen.getByText('by Maya Owner')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit order' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm order' })).toBeVisible();
  });

  it('moves the order through a status change with a note', async () => {
    const user = userEvent.setup();
    const confirmed = makeOrder({
      status: 'CONFIRMED',
      version: 2,
      updatedAt: updated,
      history: [makeOrder().history[0], historyEntry('CONFIRMED', 'PENDING', 'Paid in full')],
    });
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders/order-1/status' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: confirmed });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: makeOrder() });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });

    await user.click(screen.getByRole('button', { name: 'Confirm order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as confirmed?' });
    expect(within(dialog).getByText(/moves ORD-0001 from Pending to Confirmed/)).toBeVisible();

    await user.type(within(dialog).getByLabelText('Note'), 'Paid in full');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm order' }));

    expect(await screen.findByText('Order moved to Confirmed.')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const statusCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/orders/order-1/status' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(statusCall).toBeDefined();
    expect(JSON.parse(String((statusCall?.[1] as RequestInit).body))).toEqual({
      status: 'CONFIRMED',
      version: 1,
      note: 'Paid in full',
    });
  });

  it('saves an edit with the existing line ids and version', async () => {
    const user = userEvent.setup();
    const edited = makeOrder({
      notes: 'Leave at the desk',
      version: 2,
      updatedAt: updated,
    });
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders/order-1' && init?.method === 'PATCH') {
        return jsonResponse(200, { success: true, data: edited });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: makeOrder() });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });

    await user.click(screen.getByRole('button', { name: 'Edit order' }));
    expect(await screen.findByRole('heading', { name: 'Edit ORD-0001' })).toBeVisible();
    expect(screen.getByText('Saved line')).toBeVisible();

    const notes = screen.getByLabelText('Notes');
    await user.clear(notes);
    await user.type(notes, 'Leave at the desk');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Order updated.')).toBeVisible();

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/orders/order-1' &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toEqual({
      version: 1,
      customerId: CUSTOMER_ID,
      items: [
        {
          lineId: LINE_ID,
          productId: PRODUCT_ID,
          variantId: null,
          quantity: 3,
          unitPrice: 2500,
        },
      ],
      deliveryFee: 100,
      discount: 50,
      shippingAddress: '12 Lake Road',
      notes: 'Leave at the desk',
      source: 'FACEBOOK',
      deliveryDeadline: '2026-11-05',
    });
  });

  it('locks edits after processing starts and shows only allowed moves', async () => {
    installedFetch((url) => {
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, {
          success: true,
          data: makeOrder({
            status: 'PROCESSING',
            history: [
              makeOrder().history[0],
              historyEntry('CONFIRMED', 'PENDING'),
              historyEntry('PROCESSING', 'CONFIRMED'),
            ],
          }),
        });
      }
      return metadata(url);
    });

    renderPage();

    await screen.findByRole('heading', { name: 'ORD-0001' });
    expect(screen.queryByRole('button', { name: 'Edit order' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark shipped' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm order' })).not.toBeInTheDocument();
  });

  it('cancels a pending order through the confirmation dialog', async () => {
    const user = userEvent.setup();
    const cancelled = makeOrder({
      status: 'CANCELLED',
      version: 2,
      updatedAt: updated,
      history: [
        makeOrder().history[0],
        historyEntry('CANCELLED', 'PENDING', 'Buyer changed their mind'),
      ],
    });
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders/order-1/status' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: cancelled });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: makeOrder() });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this order?' });
    await user.type(within(dialog).getByLabelText('Note'), 'Buyer changed their mind');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order' }));

    expect(await screen.findByText('Order moved to Cancelled.')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const statusCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/orders/order-1/status' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((statusCall?.[1] as RequestInit).body))).toEqual({
      status: 'CANCELLED',
      version: 1,
      note: 'Buyer changed their mind',
    });
  });

  it('returns a delivered order through the confirmation dialog', async () => {
    const user = userEvent.setup();
    const delivered = makeOrder({
      status: 'DELIVERED',
      version: 5,
      updatedAt: updated,
      history: [
        makeOrder().history[0],
        historyEntry('CONFIRMED', 'PENDING'),
        historyEntry('PROCESSING', 'CONFIRMED'),
        historyEntry('SHIPPED', 'PROCESSING'),
        historyEntry('DELIVERED', 'SHIPPED'),
      ],
    });
    const returned = makeOrder({
      status: 'RETURNED',
      version: 6,
      updatedAt: updated,
      history: [...delivered.history, historyEntry('RETURNED', 'DELIVERED')],
    });
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders/order-1/status' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: returned });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: delivered });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });
    expect(screen.queryByRole('button', { name: 'Edit order' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark returned' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark this order as returned?' });
    await user.click(within(dialog).getByRole('button', { name: 'Mark returned' }));

    expect(await screen.findByText('Order moved to Returned.')).toBeVisible();

    const statusCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/orders/order-1/status' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((statusCall?.[1] as RequestInit).body))).toEqual({
      status: 'RETURNED',
      version: 5,
      note: null,
    });
  });

  it('shows a not-found message when the order cannot be loaded', async () => {
    installedFetch((url) => {
      if (url === '/api/orders/order-1') {
        return jsonResponse(404, { error: 'NOT_FOUND', message: 'Order not found' });
      }
      return metadata(url);
    });

    renderPage();

    expect(await screen.findByText('Order not found')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('reloads and explains when the order changed elsewhere', async () => {
    const user = userEvent.setup();
    let order = makeOrder();
    installedFetch((url, init) => {
      if (url === '/api/orders/order-1/status' && init?.method === 'POST') {
        order = makeOrder({
          status: 'CONFIRMED',
          version: 2,
          history: [makeOrder().history[0], historyEntry('CONFIRMED', 'PENDING')],
        });
        return jsonResponse(409, {
          error: 'ORDER_CHANGED',
          message: 'This order changed since you loaded it.',
        });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: order });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });

    await user.click(screen.getByRole('button', { name: 'Confirm order' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as confirmed?' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm order' }));

    await waitFor(() => {
      expect(
        screen.getByText('This order changed elsewhere. The newest state is shown.'),
      ).toBeVisible();
    });
    expect(await screen.findByRole('button', { name: 'Start processing' })).toBeVisible();
  });

  // covers AC-16 and AC-19: the header shows the promise and flags a late active order
  it('shows the delivery deadline with an overdue badge', async () => {
    installedFetch((url) => {
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, {
          success: true,
          data: makeOrder({ deliveryDeadline: '2020-01-01' }),
        });
      }
      return metadata(url);
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'ORD-0001' })).toBeVisible();
    expect(screen.getByText('Jan 1, 2020')).toBeVisible();
    expect(screen.getByText('Overdue')).toBeVisible();
  });

  // covers AC-16: an order with no promise reads as not set
  it('reads Not set when the order has no delivery deadline', async () => {
    installedFetch((url) => {
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, {
          success: true,
          data: makeOrder({ deliveryDeadline: null }),
        });
      }
      return metadata(url);
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'ORD-0001' })).toBeVisible();
    expect(screen.getByText('Not set')).toBeVisible();
    expect(screen.queryByText('Overdue')).toBeNull();
  });

  // covers AC-16: the edit conflict reloads the newest details instead of the old form
  it('reloads the newest details when an edit conflicts', async () => {
    const user = userEvent.setup();
    let order = makeOrder();
    const reloaded = makeOrder({ notes: 'Leave at the desk', version: 2, updatedAt: updated });
    installedFetch((url, init) => {
      if (url === '/api/orders/order-1' && init?.method === 'PATCH') {
        order = reloaded;
        return jsonResponse(409, {
          error: 'ORDER_CHANGED',
          message: 'This order changed since you loaded it.',
        });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: order });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });

    await user.click(screen.getByRole('button', { name: 'Edit order' }));
    expect(await screen.findByRole('heading', { name: 'Edit ORD-0001' })).toBeVisible();

    const notes = screen.getByLabelText('Notes');
    await user.clear(notes);
    await user.type(notes, 'Leave at the desk');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText('This order changed elsewhere. The newest details are shown.'),
    ).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Edit order' })).toBeVisible();
    expect(screen.getByText('Leave at the desk')).toBeVisible();
  });

  // covers AC-16: a closed order has no further moves and no edit action
  it('explains that a closed order cannot move further', async () => {
    installedFetch((url) => {
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: makeOrder({ status: 'CANCELLED' }) });
      }
      return metadata(url);
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'ORD-0001' })).toBeVisible();
    expect(
      screen.getByText('This order is closed. No further status changes are possible.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm order' })).not.toBeInTheDocument();
  });

  // covers AC-16, AC-19: OWNER records payment, records refund (prefilled on closed, blank on active), and voids live entries.
  it('lets OWNER record a payment, record a refund, and void an entry with a reason', async () => {
    const user = userEvent.setup();
    const paymentEntry = {
      id: 'pay-1',
      kind: 'PAYMENT' as const,
      amount: 3000,
      method: 'BKASH' as const,
      paymentDate: '2026-10-20',
      referenceNumber: 'TRX-1',
      notes: null,
      recordedByName: 'Maya Owner',
      voidedAt: null,
      voidedByName: null,
      voidReason: null,
      createdAt: created,
    };
    const afterPayment = makeOrder({
      paidAmount: 3000,
      dueAmount: 4550,
      paymentStatus: 'PARTIAL',
      payments: [paymentEntry],
    });
    const afterRefund = makeOrder({
      paidAmount: 2000,
      dueAmount: 5550,
      paymentStatus: 'PARTIAL',
      payments: [
        paymentEntry,
        {
          ...paymentEntry,
          id: 'pay-2',
          kind: 'REFUND',
          amount: 1000,
          method: 'CASH',
          referenceNumber: null,
        },
      ],
    });
    const afterVoid = makeOrder({
      paidAmount: 3000,
      dueAmount: 4550,
      paymentStatus: 'PARTIAL',
      payments: [
        paymentEntry,
        {
          ...afterRefund.payments[1],
          voidedAt: updated,
          voidedByName: 'Maya Owner',
          voidReason: 'Mistaken refund',
        },
      ],
    });

    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT', role: 'OWNER' } });
      }
      if (url === '/api/orders/order-1/payments' && init?.method === 'POST') {
        return jsonResponse(201, { success: true, data: afterPayment });
      }
      if (url === '/api/orders/order-1/refunds' && init?.method === 'POST') {
        return jsonResponse(201, { success: true, data: afterRefund });
      }
      if (url === '/api/orders/order-1/payments/pay-2/void' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: afterVoid });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: makeOrder() });
      }
      return undefined;
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });

    // 1. Record payment
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    const payDialog = await screen.findByRole('dialog', { name: 'Record payment' });
    const amountInput = within(payDialog).getByLabelText('Amount');
    expect(amountInput).toHaveValue(7550);
    await user.clear(amountInput);
    await user.type(amountInput, '3000');
    await user.click(within(payDialog).getByRole('button', { name: 'Save payment' }));

    expect(await screen.findByText('Payment recorded.')).toBeVisible();
    const payCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/orders/order-1/payments' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(new Headers((payCall?.[1] as RequestInit).headers).get('Idempotency-Key')).toBeTruthy();

    // 2. Record refund on active order starts with a blank amount.
    await user.click(await screen.findByRole('button', { name: 'Record refund' }));
    const refundDialog = await screen.findByRole('dialog', { name: 'Record refund' });
    const refundAmount = within(refundDialog).getByLabelText('Amount');
    expect(refundAmount).toHaveValue(null);
    await user.type(refundAmount, '1000');
    await user.click(within(refundDialog).getByRole('button', { name: 'Save refund' }));

    expect(await screen.findByText('Refund recorded.')).toBeVisible();

    // 3. Void the refund with a reason.
    await user.click(screen.getByRole('button', { name: /Void refund of 1,000 BDT/i }));
    const voidDialog = await screen.findByRole('dialog', { name: 'Void this refund?' });
    await user.type(within(voidDialog).getByLabelText('Reason'), 'Mistaken refund');
    await user.click(within(voidDialog).getByRole('button', { name: 'Void entry' }));

    expect(await screen.findByText('Entry voided.')).toBeVisible();
    expect(screen.getByText(/Voided by Maya Owner: Mistaken refund/)).toBeVisible();
  });

  // covers AC-16, AC-19: STAFF cannot see Record refund or Void, and closed order prefills refundOwed for OWNER.
  it('hides refund and void controls from STAFF while keeping Record payment', async () => {
    const partialOrder = makeOrder({
      paidAmount: 2000,
      dueAmount: 5550,
      paymentStatus: 'PARTIAL',
      payments: [
        {
          id: 'pay-1',
          kind: 'PAYMENT',
          amount: 2000,
          method: 'CASH',
          paymentDate: '2026-10-20',
          referenceNumber: null,
          notes: null,
          recordedByName: 'Sam Staff',
          voidedAt: null,
          voidedByName: null,
          voidReason: null,
          createdAt: created,
        },
      ],
    });

    installedFetch((url) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT', role: 'STAFF' } });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: partialOrder });
      }
      return undefined;
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });

    expect(screen.getByRole('button', { name: 'Record payment' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Void/ })).not.toBeInTheDocument();
  });

  // covers AC-19: closed order prefills refundOwed; 409 conflict rules close vs keep dialogs open; TOTAL_BELOW_PAID stays in edit mode.
  it('prefills refundOwed on closed orders, applies 409 dialog rules, and keeps edit form open on TOTAL_BELOW_PAID', async () => {
    const user = userEvent.setup();
    const closedOrder = makeOrder({
      status: 'CANCELLED',
      paidAmount: 2000,
      dueAmount: 0,
      refundOwed: 2000,
      paymentStatus: 'REFUND_OWED',
      payments: [
        {
          id: 'pay-1',
          kind: 'PAYMENT',
          amount: 2000,
          method: 'CASH',
          paymentDate: '2026-10-20',
          referenceNumber: null,
          notes: null,
          recordedByName: 'Maya Owner',
          voidedAt: null,
          voidedByName: null,
          voidReason: null,
          createdAt: created,
        },
      ],
    });

    installedFetch((url, init) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT', role: 'OWNER' } });
      }
      if (url === '/api/orders/order-1/refunds' && init?.method === 'POST') {
        return jsonResponse(409, {
          error: 'REFUND_EXCEEDS_PAID',
          message: 'Refund exceeds paid amount',
          paidAmount: 1000,
        });
      }
      if (url === '/api/orders/order-1/payments/pay-1/void' && init?.method === 'POST') {
        return jsonResponse(409, {
          error: 'PAYMENT_ALREADY_VOIDED',
          message: 'Payment is already voided.',
        });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, { success: true, data: closedOrder });
      }
      return undefined;
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });

    // Closed order prefills refundOwed (2000); REFUND_EXCEEDS_PAID keeps dialog open with refreshed amount.
    await user.click(await screen.findByRole('button', { name: 'Record refund' }));
    const refundDialog = await screen.findByRole('dialog', { name: 'Record refund' });
    expect(within(refundDialog).getByLabelText('Amount')).toHaveValue(2000);
    await user.click(within(refundDialog).getByRole('button', { name: 'Save refund' }));

    expect(await within(refundDialog).findByText(/Current paid amount is 1,000 BDT/)).toBeVisible();
    await user.click(within(refundDialog).getByRole('button', { name: 'Cancel' }));

    // PAYMENT_ALREADY_VOIDED closes void dialog and surfaces page error.
    await user.click(screen.getByRole('button', { name: /Void payment of 2,000 BDT/i }));
    const voidDialog = await screen.findByRole('dialog', { name: 'Void this payment?' });
    await user.type(within(voidDialog).getByLabelText('Reason'), 'Already gone');
    await user.click(within(voidDialog).getByRole('button', { name: 'Void entry' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Payment is already voided.')).toBeVisible();
  });

  it('keeps the edit form open and explains when PATCH hits 409 TOTAL_BELOW_PAID', async () => {
    const user = userEvent.setup();
    installedFetch((url, init) => {
      if (url === '/api/orders/order-1' && init?.method === 'PATCH') {
        return jsonResponse(409, {
          error: 'TOTAL_BELOW_PAID',
          message: 'Order total cannot be lower than paid amount.',
          paidAmount: 5000,
        });
      }
      if (url === '/api/orders/order-1') {
        return jsonResponse(200, {
          success: true,
          data: makeOrder({ paidAmount: 5000, dueAmount: 2550, paymentStatus: 'PARTIAL' }),
        });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByRole('heading', { name: 'ORD-0001' });

    await user.click(screen.getByRole('button', { name: 'Edit order' }));
    expect(await screen.findByRole('heading', { name: 'Edit ORD-0001' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText(/Refund or void payments before lowering the order total/),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Edit ORD-0001' })).toBeVisible();
  });
});
