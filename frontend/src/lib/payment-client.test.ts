import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDto, PaymentLedgerPageDto } from '@f-commerce/contracts';
import { clearAuth, setAuth } from './auth-client';
import { OrderApiError } from './order-client';
import {
  buildPaymentLedgerQuery,
  listPayments,
  recordOrderPayment,
  recordOrderRefund,
  voidOrderPayment,
} from './payment-client';

const CREATED_AT = '2026-11-26T10:00:00.000Z';

function makeOrder(overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    id: 'order-1',
    orderNumber: 'ORD-0001',
    status: 'PENDING',
    source: 'DIRECT',
    customerId: '11111111-1111-4111-8111-111111111111',
    customerName: 'Nusrat Jahan',
    customerPhone: '+8801712345678',
    shippingAddress: null,
    notes: null,
    deliveryDeadline: null,
    subtotal: 2500,
    deliveryFee: 0,
    discount: 0,
    total: 2500,
    paidAmount: 500,
    dueAmount: 2000,
    refundOwed: 0,
    paymentStatus: 'PARTIAL',
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    items: [],
    history: [],
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

describe('buildPaymentLedgerQuery', () => {
  // covers spec 0010 AC-17 and AC-21: query serializer omits empty fields and encodes explicit filters
  it('returns an empty string when no filters are provided and serializes active filters', () => {
    expect(buildPaymentLedgerQuery({})).toBe('');
    expect(buildPaymentLedgerQuery({ methods: [], kind: '', cursor: null })).toBe('');
    expect(
      buildPaymentLedgerQuery({
        from: '2026-11-01',
        to: '2026-11-26',
        methods: ['BKASH', 'CASH'],
        kind: 'REFUND',
        limit: 20,
        cursor: 'cur-1',
      }),
    ).toBe('?from=2026-11-01&to=2026-11-26&method=BKASH%2CCASH&kind=REFUND&limit=20&cursor=cur-1');
  });
});

describe('payment client requests', () => {
  beforeEach(() => {
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
  });

  afterEach(() => {
    clearAuth();
    vi.unstubAllGlobals();
  });

  // covers spec 0010 AC-3 and AC-12: payment write sends Idempotency-Key and unwraps data
  it('posts a payment with encoded order id and Idempotency-Key header', async () => {
    const order = makeOrder();
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders/order%2F1/payments' && init?.method === 'POST') {
        return jsonResponse(201, { success: true, data: order });
      }
      return undefined;
    });

    const result = await recordOrderPayment(
      'order/1',
      { amount: 500, method: 'BKASH', paymentDate: null, referenceNumber: 'TRX-1', notes: null },
      'idem-pay-1',
    );

    expect(result).toEqual(order);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('idem-pay-1');
    expect(JSON.parse(String(init.body))).toEqual({
      amount: 500,
      method: 'BKASH',
      paymentDate: null,
      referenceNumber: 'TRX-1',
      notes: null,
    });
  });

  // covers spec 0010 AC-5 and AC-12: refund write sends Idempotency-Key and unwraps data
  it('posts a refund with Idempotency-Key header', async () => {
    const order = makeOrder({ paidAmount: 200, dueAmount: 2300 });
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders/order-1/refunds' && init?.method === 'POST') {
        return jsonResponse(201, { success: true, data: order });
      }
      return undefined;
    });

    const result = await recordOrderRefund(
      'order-1',
      { amount: 300, method: 'CASH', paymentDate: null, referenceNumber: null, notes: null },
      'idem-ref-1',
    );

    expect(result).toEqual(order);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('idem-ref-1');
  });

  // covers spec 0010 AC-6 and AC-12: void endpoint does not send Idempotency-Key
  it('posts a void without Idempotency-Key header', async () => {
    const order = makeOrder({ paidAmount: 0, dueAmount: 2500, paymentStatus: 'UNPAID' });
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders/order-1/payments/pay%2F2/void' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: order });
      }
      return undefined;
    });

    const result = await voidOrderPayment('order-1', 'pay/2', { reason: 'Wrong amount' });

    expect(result).toEqual(order);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Idempotency-Key')).toBeNull();
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'Wrong amount' });
  });

  // covers spec 0010 AC-17: lists ledger entries with serialized query filters
  it('lists payments from /api/payments and unwraps the ledger page', async () => {
    const page: PaymentLedgerPageDto = {
      items: [],
      summary: { collected: 1000, refunded: 200, net: 800 },
      nextCursor: null,
    };
    const fetchMock = installedFetch((url) => {
      if (url === '/api/payments?from=2026-11-01&to=2026-11-26&limit=20') {
        return jsonResponse(200, { success: true, data: page });
      }
      return undefined;
    });

    const result = await listPayments({ from: '2026-11-01', to: '2026-11-26', limit: 20 });

    expect(result).toEqual(page);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      '/api/payments?from=2026-11-01&to=2026-11-26&limit=20',
    );
  });

  // covers spec 0010 AC-4, AC-5, AC-6, AC-14: preserves balance fields on OrderApiError and handles non-JSON errors
  it('throws OrderApiError with balance fields and handles non-JSON error bodies safely', async () => {
    installedFetch(() =>
      jsonResponse(409, {
        error: 'PAYMENT_EXCEEDS_DUE',
        message: 'Payment exceeds remaining due.',
        dueAmount: 100,
        paidAmount: 400,
        total: 500,
        fields: ['amount'],
      }),
    );

    await expect(
      recordOrderPayment(
        'order-1',
        { amount: 200, method: 'CASH', paymentDate: null, referenceNumber: null, notes: null },
        'idem-1',
      ),
    ).rejects.toMatchObject({
      name: 'OrderApiError',
      status: 409,
      code: 'PAYMENT_EXCEEDS_DUE',
      fields: ['amount'],
      body: { dueAmount: 100, paidAmount: 400, total: 500 },
    } satisfies Partial<OrderApiError>);

    installedFetch(
      () => new Response('Bad gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } }),
    );
    await expect(listPayments({})).rejects.toMatchObject({
      name: 'OrderApiError',
      status: 502,
      message: 'The request failed',
    });
  });
});
