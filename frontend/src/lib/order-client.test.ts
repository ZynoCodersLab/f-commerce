import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderCreateRequest, OrderDto } from '@f-commerce/contracts';
import { clearAuth, setAuth } from './auth-client';
import {
  OrderApiError,
  buildOrderQuery,
  changeOrderStatus,
  createOrder,
  getOrder,
  listOrders,
  updateOrder,
} from './order-client';

const CREATED_AT = '2026-10-20T10:00:00.000Z';

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
    paidAmount: 0,
    dueAmount: 2500,
    refundOwed: 0,
    paymentStatus: 'UNPAID',
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

function requestBody(call: unknown[] | undefined): unknown {
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

describe('buildOrderQuery', () => {
  it('returns an empty string when there is nothing to send', () => {
    expect(buildOrderQuery({})).toBe('');
  });

  it('serializes the status set, trimmed search, limit, and cursor', () => {
    expect(
      buildOrderQuery({
        statuses: ['PENDING', 'CONFIRMED'],
        q: '  Nusrat  ',
        limit: 20,
        cursor: 'cursor-1',
      }),
    ).toBe('?status=PENDING%2CCONFIRMED&q=Nusrat&limit=20&cursor=cursor-1');
  });

  it('omits an empty status set, a blank search, and a null cursor', () => {
    expect(buildOrderQuery({ statuses: [], q: '   ', cursor: null })).toBe('');
  });
});

describe('order requests', () => {
  beforeEach(() => {
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
  });

  afterEach(() => {
    clearAuth();
    vi.unstubAllGlobals();
  });

  it('lists orders from the query string and unwraps the page', async () => {
    const fetchMock = installedFetch((url) => {
      if (url.startsWith('/api/orders?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [], nextCursor: null },
        });
      }
      return undefined;
    });

    const page = await listOrders({ statuses: ['PENDING'], q: 'Nusrat', limit: 20 });

    expect(page).toEqual({ items: [], nextCursor: null });
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/orders?status=PENDING&q=Nusrat&limit=20');
  });

  it('loads one order with the id encoded into the path', async () => {
    const fetchMock = installedFetch((url) => {
      if (url === '/api/orders/a%2Fb') {
        return jsonResponse(200, { success: true, data: makeOrder() });
      }
      return undefined;
    });

    const order = await getOrder('a/b');

    expect(order.orderNumber).toBe('ORD-0001');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/orders/a%2Fb');
  });

  it('creates an order with a JSON body and an idempotency key', async () => {
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders' && init?.method === 'POST') {
        return jsonResponse(201, { success: true, data: makeOrder() });
      }
      return undefined;
    });
    const input: OrderCreateRequest = {
      customerId: '11111111-1111-4111-8111-111111111111',
      items: [{ productId: '22222222-2222-4222-8222-222222222222', quantity: 1 }],
      source: 'DIRECT',
      deliveryFee: 0,
      discount: 0,
      shippingAddress: null,
      notes: null,
      deliveryDeadline: null,
      confirmDuplicate: false,
    };

    const order = await createOrder(input, 'key-1');

    expect(order.id).toBe('order-1');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('key-1');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual(input);
  });

  it('patches an order with the edit payload', async () => {
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders/order-1' && init?.method === 'PATCH') {
        return jsonResponse(200, { success: true, data: makeOrder({ version: 2 }) });
      }
      return undefined;
    });

    const order = await updateOrder('order-1', {
      version: 1,
      shippingAddress: undefined,
      notes: 'Leave at the desk',
    });

    expect(order.version).toBe(2);
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      version: 1,
      notes: 'Leave at the desk',
    });
  });

  it('posts a status change to the status route', async () => {
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/orders/order-1/status' && init?.method === 'POST') {
        return jsonResponse(200, {
          success: true,
          data: makeOrder({ status: 'CONFIRMED', version: 2 }),
        });
      }
      return undefined;
    });

    const order = await changeOrderStatus('order-1', {
      status: 'CONFIRMED',
      version: 1,
      note: null,
    });

    expect(order.status).toBe('CONFIRMED');
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      status: 'CONFIRMED',
      version: 1,
      note: null,
    });
  });
});

describe('order errors', () => {
  beforeEach(() => {
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
  });

  afterEach(() => {
    clearAuth();
    vi.unstubAllGlobals();
  });

  it('exposes the duplicate order returned with a 409', async () => {
    installedFetch((url) => {
      if (url === '/api/orders') {
        return jsonResponse(409, {
          error: 'DUPLICATE_ORDER',
          message: 'A similar order was created in the last 24 hours',
          existingOrder: {
            id: 'order-9',
            orderNumber: 'ORD-0009',
            status: 'PENDING',
            total: 5000,
            createdAt: CREATED_AT,
          },
        });
      }
      return undefined;
    });

    const error = await createOrder(
      {
        customerId: '11111111-1111-4111-8111-111111111111',
        items: [{ productId: '22222222-2222-4222-8222-222222222222', quantity: 1 }],
        source: 'DIRECT',
        deliveryFee: 0,
        discount: 0,
        shippingAddress: null,
        notes: null,
        deliveryDeadline: null,
        confirmDuplicate: false,
      },
      'key-1',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OrderApiError);
    const apiError = error as OrderApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe('DUPLICATE_ORDER');
    expect(apiError.body.existingOrder).toEqual({
      id: 'order-9',
      orderNumber: 'ORD-0009',
      status: 'PENDING',
      total: 5000,
      createdAt: CREATED_AT,
    });
  });

  it('keeps the field names and message from a validation error', async () => {
    installedFetch(() =>
      jsonResponse(400, {
        error: 'VALIDATION_ERROR',
        message: 'The discount cannot exceed the subtotal',
        fields: ['discount', 'items', 7],
      }),
    );

    const error = (await updateOrder('order-1', {
      version: 1,
      shippingAddress: undefined,
      notes: undefined,
    }).catch((caught: unknown) => caught)) as OrderApiError;

    expect(error).toBeInstanceOf(OrderApiError);
    expect(error.status).toBe(400);
    expect(error.fields).toEqual(['discount', 'items']);
    expect(error.message).toBe('The discount cannot exceed the subtotal');
  });

  it('falls back when the error body is not JSON', async () => {
    installedFetch(() => new Response('<html>bad gateway</html>', { status: 500 }));

    const error = (await listOrders({}).catch((caught: unknown) => caught)) as OrderApiError;

    expect(error).toBeInstanceOf(OrderApiError);
    expect(error.message).toBe('The request failed');
    expect(error.fields).toEqual([]);
    expect(error.code).toBeUndefined();
  });

  it('ignores a malformed existing order in a duplicate error', async () => {
    installedFetch(() =>
      jsonResponse(409, {
        error: 'DUPLICATE_ORDER',
        message: 'A similar order exists',
        existingOrder: { id: 'order-9' },
      }),
    );

    const error = (await createOrder(
      {
        customerId: '11111111-1111-4111-8111-111111111111',
        items: [{ productId: '22222222-2222-4222-8222-222222222222', quantity: 1 }],
        source: 'DIRECT',
        deliveryFee: 0,
        discount: 0,
        shippingAddress: null,
        notes: null,
        deliveryDeadline: null,
        confirmDuplicate: false,
      },
      'key-1',
    ).catch((caught: unknown) => caught)) as OrderApiError;

    expect(error).toBeInstanceOf(OrderApiError);
    expect(error.body.existingOrder).toBeUndefined();
  });
});
