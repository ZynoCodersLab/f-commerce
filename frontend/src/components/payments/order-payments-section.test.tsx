import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDto, PaymentEntryDto } from '@f-commerce/contracts';
import { ThemeBoundary } from '@/components/theme/theme';
import { clearAuth, setAuth } from '@/lib/auth-client';
import { render } from '@/test-utils/render';
import { OrderPaymentsSection } from './order-payments-section';

const CREATED_AT = '2026-11-26T10:00:00.000Z';

function makeEntry(overrides: Partial<PaymentEntryDto> = {}): PaymentEntryDto {
  return {
    id: 'pay-1',
    kind: 'PAYMENT',
    amount: 500,
    method: 'CASH',
    referenceNumber: null,
    notes: null,
    paymentDate: '2026-11-26',
    recordedByName: 'Maya Owner',
    createdAt: CREATED_AT,
    voidedAt: null,
    voidedByName: null,
    voidReason: null,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    id: 'order-1',
    orderNumber: 'ORD-0001',
    status: 'PENDING',
    source: 'DIRECT',
    customerId: '11111111-1111-4111-8111-111111111111',
    customerName: 'Nusrat Jahan',
    customerPhone: '+8801712345678',
    shippingAddress: '12 Lake Road',
    notes: null,
    deliveryDeadline: null,
    subtotal: 1200,
    deliveryFee: 0,
    discount: 0,
    total: 1200,
    paidAmount: 500,
    dueAmount: 700,
    refundOwed: 0,
    paymentStatus: 'PARTIAL',
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    items: [],
    history: [],
    payments: [makeEntry()],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
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

function renderSection(
  order: OrderDto = makeOrder(),
  callbacks?: {
    onOrderUpdated?: (order: OrderDto, noticeMessage: string) => void;
    onRefresh?: () => Promise<void>;
    onNotice?: (message: string, tone: 'success' | 'neutral') => void;
    onActionError?: (message: string) => void;
  },
) {
  const onOrderUpdated = callbacks?.onOrderUpdated ?? vi.fn();
  const onRefresh = callbacks?.onRefresh ?? vi.fn().mockResolvedValue(undefined);
  const onNotice = callbacks?.onNotice ?? vi.fn();
  const onActionError = callbacks?.onActionError ?? vi.fn();

  const view = render(
    <ThemeBoundary>
      <OrderPaymentsSection
        onActionError={onActionError}
        onNotice={onNotice}
        onOrderUpdated={onOrderUpdated}
        onRefresh={onRefresh}
        order={order}
      />
    </ThemeBoundary>,
  );

  return { ...view, onOrderUpdated, onRefresh, onNotice, onActionError };
}

describe('OrderPaymentsSection', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAuth();
    vi.unstubAllGlobals();
  });

  // covers spec 0010 AC-12 and AC-19: one Idempotency-Key per dialog open, reused on retry, fresh on reopen
  it('reuses the same Idempotency-Key on retry within one open dialog and rotates it on reopen', async () => {
    const user = userEvent.setup();
    let paymentPosts = 0;

    const fetchMock = installFetch((url, init) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, {
          success: true,
          data: { currency: 'BDT', timezone: 'Asia/Dhaka', role: 'OWNER' },
        });
      }
      if (url === '/api/orders/order-1/payments' && init?.method === 'POST') {
        paymentPosts += 1;
        if (paymentPosts === 1) {
          return jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'Temporary error' });
        }
        return jsonResponse(201, {
          success: true,
          data: makeOrder({ paidAmount: 1000, dueAmount: 200 }),
        });
      }
      return undefined;
    });

    const { onOrderUpdated } = renderSection(makeOrder({ dueAmount: 700, paidAmount: 500 }));
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    let dialog = await screen.findByRole('dialog', { name: 'Record payment' });

    await user.clear(within(dialog).getByLabelText('Amount'));
    await user.type(within(dialog).getByLabelText('Amount'), '200');
    await user.click(within(dialog).getByRole('button', { name: 'Save payment' }));
    expect(await within(dialog).findByText('Temporary error')).toBeVisible();

    // Retry while dialog remains open -> must reuse the same key.
    await user.click(within(dialog).getByRole('button', { name: 'Save payment' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onOrderUpdated).toHaveBeenCalledTimes(1);

    // Reopen dialog -> must generate a new key.
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    dialog = await screen.findByRole('dialog', { name: 'Record payment' });
    await user.clear(within(dialog).getByLabelText('Amount'));
    await user.type(within(dialog).getByLabelText('Amount'), '100');
    await user.click(within(dialog).getByRole('button', { name: 'Save payment' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const postKeys = fetchMock.mock.calls
      .filter(
        ([url, init]) =>
          String(url) === '/api/orders/order-1/payments' &&
          (init as RequestInit | undefined)?.method === 'POST',
      )
      .map(([, init]) => new Headers((init as RequestInit).headers).get('Idempotency-Key'));

    expect(postKeys).toHaveLength(3);
    expect(postKeys[0]).toBeTruthy();
    expect(postKeys[1]).toBe(postKeys[0]);
    expect(postKeys[2]).not.toBe(postKeys[0]);
  });

  // covers spec 0010 AC-14, AC-18, AC-19: method-specific reference labels, CARD warning, client amount/date checks
  it('updates reference labels and card notice by method and validates amount and future date client-side', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch((url) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, {
          success: true,
          data: { currency: 'BDT', timezone: 'Asia/Dhaka', role: 'OWNER' },
        });
      }
      return undefined;
    });

    renderSection(makeOrder({ dueAmount: 700, paidAmount: 500 }));
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record payment' });

    const methodSelect = within(dialog).getByLabelText('Payment method');
    expect(within(dialog).getByLabelText('Reference (optional)')).toBeVisible();

    await user.selectOptions(methodSelect, 'BKASH');
    expect(within(dialog).getByLabelText('Transaction ID (optional)')).toBeVisible();

    await user.selectOptions(methodSelect, 'CARD');
    expect(within(dialog).getByText(/Never enter a full card number/)).toBeVisible();

    const amountInput = within(dialog).getByLabelText('Amount');
    await user.clear(amountInput);
    await user.type(amountInput, '701');
    await user.click(within(dialog).getByRole('button', { name: 'Save payment' }));
    expect(
      await within(dialog).findByText('Amount cannot exceed the current due of 700 BDT.'),
    ).toBeVisible();
    expect(amountInput).toHaveAttribute('aria-invalid', 'true');

    await user.clear(amountInput);
    await user.type(amountInput, '200');
    const dateInput = within(dialog).getByLabelText('Payment date') as HTMLInputElement;
    expect(dateInput).toHaveAttribute('max', '2026-11-26');
    await user.clear(dateInput);
    await user.type(dateInput, '2026-11-27');
    expect(dateInput.validity.rangeOverflow).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Save payment' }));

    const paymentCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/payments'));
    expect(paymentCalls).toHaveLength(0);
  });

  // covers spec 0010 AC-4, AC-6, AC-19: 409 ORDER_CLOSED closes dialog, PAYMENT_EXCEEDS_DUE & VOID_BREAKS_BALANCE stay open
  it('handles 409 ORDER_CLOSED, PAYMENT_EXCEEDS_DUE, and VOID_BREAKS_BALANCE per conflict rules', async () => {
    const user = userEvent.setup();
    let paymentErrorMode: 'exceeds' | 'closed' = 'exceeds';

    installFetch((url, init) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, {
          success: true,
          data: { currency: 'BDT', timezone: 'Asia/Dhaka', role: 'OWNER' },
        });
      }
      if (url === '/api/orders/order-1/payments' && init?.method === 'POST') {
        if (paymentErrorMode === 'exceeds') {
          return jsonResponse(409, {
            error: 'PAYMENT_EXCEEDS_DUE',
            message: 'Payment exceeds remaining due',
            dueAmount: 100,
          });
        }
        return jsonResponse(409, {
          error: 'ORDER_CLOSED',
          message: 'Cannot record a payment on a closed order.',
        });
      }
      if (url === '/api/orders/order-1/payments/pay-1/void' && init?.method === 'POST') {
        return jsonResponse(409, {
          error: 'VOID_BREAKS_BALANCE',
          message: 'Voiding this payment would make paid amount negative.',
          paidAmount: 200,
          total: 1200,
        });
      }
      return undefined;
    });

    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onActionError = vi.fn();
    renderSection(makeOrder(), { onRefresh, onActionError });

    // PAYMENT_EXCEEDS_DUE keeps dialog open and prints refreshed due amount.
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const payDialog = await screen.findByRole('dialog', { name: 'Record payment' });
    await user.click(within(payDialog).getByRole('button', { name: 'Save payment' }));

    expect(await within(payDialog).findByText(/Current due is 100 BDT/)).toBeVisible();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // ORDER_CLOSED closes dialog and delegates error to page banner.
    paymentErrorMode = 'closed';
    await user.click(within(payDialog).getByRole('button', { name: 'Save payment' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onActionError).toHaveBeenCalledWith('Cannot record a payment on a closed order.');

    // VOID_BREAKS_BALANCE keeps void dialog open with explanation.
    await user.click(await screen.findByRole('button', { name: /Void payment of 500 BDT/i }));
    const voidDialog = await screen.findByRole('dialog', { name: 'Void this payment?' });
    await user.type(within(voidDialog).getByLabelText('Reason'), 'Refund depends on this');
    await user.click(within(voidDialog).getByRole('button', { name: 'Void entry' }));

    expect(
      await within(voidDialog).findByText('Voiding this payment would make paid amount negative.'),
    ).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Void this payment?' })).toBeVisible();

    // Escape closes the open void dialog cleanly.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  // covers spec 0010 AC-6 and AC-19: void blocks blank reason inline and recovers on timeout
  it('blocks blank void reason inline and recovers cleanly on AbortError timeout', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/business/me') {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: { currency: 'BDT', timezone: 'Asia/Dhaka', role: 'OWNER' },
          }),
        );
      }
      return Promise.reject(new DOMException('Request timed out', 'TimeoutError'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onNotice = vi.fn();
    renderSection(makeOrder(), { onRefresh, onNotice });

    await user.click(await screen.findByRole('button', { name: /Void payment of 500 BDT/i }));
    const voidDialog = await screen.findByRole('dialog', { name: 'Void this payment?' });

    const reasonInput = within(voidDialog).getByLabelText('Reason');
    await user.type(reasonInput, '   ');
    await user.click(within(voidDialog).getByRole('button', { name: 'Void entry' }));
    expect(
      await within(voidDialog).findByText('Enter a reason for voiding this entry.'),
    ).toBeVisible();
    expect(reasonInput).toHaveAttribute('aria-invalid', 'true');

    await user.clear(reasonInput);
    await user.type(reasonInput, 'Timeout test');
    await user.click(within(voidDialog).getByRole('button', { name: 'Void entry' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith(
      'That request took too long. The order was reloaded to show its current payments.',
      'neutral',
    );
  });
});
