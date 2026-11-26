import { describe, expect, it } from 'vitest';
import {
  DuplicateOrderErrorSchema,
  ORDER_SOURCES,
  ORDER_STATUSES,
  OrderCreateSchema,
  OrderPageSchema,
  OrderSchema,
  OrderStatusChangeSchema,
  OrderSummarySchema,
  OrderUpdateSchema,
} from './index.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const VARIANT_ID = '33333333-3333-4333-8333-333333333333';
const LINE_ID = '44444444-4444-4444-8444-444444444444';

function baseCreate(overrides: Record<string, unknown> = {}) {
  return {
    customerId: CUSTOMER_ID,
    items: [{ productId: PRODUCT_ID, quantity: 1 }],
    source: 'DIRECT',
    ...overrides,
  };
}

describe('order create contract', () => {
  // covers AC-1: defaults for optional fields and the required buyer, lines, and source
  it('defaults the optional fields and keeps the line shape', () => {
    const parsed = OrderCreateSchema.parse(baseCreate());

    expect(parsed).toEqual({
      customerId: CUSTOMER_ID,
      items: [{ productId: PRODUCT_ID, quantity: 1 }],
      source: 'DIRECT',
      deliveryFee: 0,
      discount: 0,
      shippingAddress: null,
      notes: null,
      confirmDuplicate: false,
      deliveryDeadline: null,
    });
  });

  // covers AC-1: the optional variant and unit price stay absent until they are sent
  it('accepts a variant and a unit price override on a line', () => {
    const parsed = OrderCreateSchema.parse(
      baseCreate({
        items: [{ productId: PRODUCT_ID, variantId: VARIANT_ID, quantity: 3, unitPrice: 0 }],
      }),
    );

    expect(parsed.items[0]).toEqual({
      productId: PRODUCT_ID,
      variantId: VARIANT_ID,
      quantity: 3,
      unitPrice: 0,
    });
  });

  // covers AC-11: optional text is trimmed, and a blank value means no value
  it('trims optional text and stores a blank value as null', () => {
    const parsed = OrderCreateSchema.parse(
      baseCreate({
        shippingAddress: '  12 Lake Road  ',
        notes: '   ',
      }),
    );

    expect(parsed.shippingAddress).toBe('12 Lake Road');
    expect(parsed.notes).toBeNull();
  });

  // covers AC-11: the 500 character limit is measured after trimming
  it('accepts text that is 500 characters after trimming', () => {
    const address = 'a'.repeat(500);
    const parsed = OrderCreateSchema.safeParse(baseCreate({ shippingAddress: `${address}   ` }));

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.shippingAddress).toBe(address);
  });

  // covers AC-11: the limit still rejects text above 500 characters after trimming
  it('rejects text above 500 characters after trimming', () => {
    const overLimit = `${'a'.repeat(501)}   `;

    expect(OrderCreateSchema.safeParse(baseCreate({ shippingAddress: overLimit })).success).toBe(
      false,
    );
    expect(OrderCreateSchema.safeParse(baseCreate({ notes: overLimit })).success).toBe(false);
  });

  // covers AC-1 and AC-11: the numeric and identifier limits on every line
  it.each<[string, Record<string, unknown>]>([
    ['a missing customer', { customerId: undefined }],
    ['an empty line list', { items: [] }],
    [
      'a line list above the raw payload cap',
      { items: Array.from({ length: 201 }, () => ({ productId: PRODUCT_ID, quantity: 1 })) },
    ],
    ['a quantity of zero', { items: [{ productId: PRODUCT_ID, quantity: 0 }] }],
    ['a quantity above 1000', { items: [{ productId: PRODUCT_ID, quantity: 1001 }] }],
    ['a fractional quantity', { items: [{ productId: PRODUCT_ID, quantity: 1.5 }] }],
    ['a negative unit price', { items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: -1 }] }],
    [
      'a unit price above the cap',
      { items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: 100_000_001 }] },
    ],
    [
      'a fractional unit price',
      { items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: 10.5 }] },
    ],
    ['an unknown source', { source: 'CARRIER_PIGEON' }],
    ['a customer id that is not a UUID', { customerId: 'customer-1' }],
    ['a product id that is not a UUID', { items: [{ productId: 'product-1', quantity: 1 }] }],
  ])('rejects %s', (_label, overrides) => {
    expect(OrderCreateSchema.safeParse(baseCreate(overrides)).success).toBe(false);
  });

  // covers AC-1 and AC-11: same pair rows merge before the 50 line limit is checked
  it('accepts more than 50 raw rows when they merge into one line', () => {
    const items = Array.from({ length: 60 }, () => ({
      productId: PRODUCT_ID,
      quantity: 1,
      unitPrice: 100,
    }));

    expect(OrderCreateSchema.safeParse(baseCreate({ items })).success).toBe(true);
  });

  // covers AC-11: exactly 50 rows and the money boundary are allowed
  it('accepts 50 rows and a unit price at the cap', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      productId: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      quantity: 1,
    }));

    const atTheCap = OrderCreateSchema.safeParse(
      baseCreate({ items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: 100_000_000 }] }),
    );

    expect(atTheCap.success).toBe(true);
    expect(OrderCreateSchema.safeParse(baseCreate({ items })).success).toBe(true);
  });
  // covers AC-19: an omitted value stays null on create while a blank or null also stores null
  it('treats an omitted, null, and blank delivery deadline as null on create', () => {
    expect(OrderCreateSchema.parse(baseCreate()).deliveryDeadline).toBeNull();
    expect(
      OrderCreateSchema.parse(baseCreate({ deliveryDeadline: null })).deliveryDeadline,
    ).toBeNull();
    expect(
      OrderCreateSchema.parse(baseCreate({ deliveryDeadline: '   ' })).deliveryDeadline,
    ).toBeNull();
  });

  // covers AC-19: a real calendar day is accepted and a day that does not exist is rejected
  it('accepts a real delivery deadline and rejects an impossible calendar day', () => {
    expect(
      OrderCreateSchema.parse(baseCreate({ deliveryDeadline: '2026-11-05' })).deliveryDeadline,
    ).toBe('2026-11-05');
    expect(
      OrderCreateSchema.safeParse(baseCreate({ deliveryDeadline: '2026-02-30' })).success,
    ).toBe(false);
    expect(
      OrderCreateSchema.safeParse(baseCreate({ deliveryDeadline: '2026-13-01' })).success,
    ).toBe(false);
    expect(OrderCreateSchema.safeParse(baseCreate({ deliveryDeadline: '2026-1-1' })).success).toBe(
      false,
    );
  });
});

describe('order edit contract', () => {
  // covers AC-9: omitted fields stay untouched while a blank value clears them
  it('keeps an omitted field absent and turns a blank value into a clear', () => {
    const omitted = OrderUpdateSchema.parse({ version: 2 });
    expect(omitted.shippingAddress).toBeUndefined();
    expect(omitted.notes).toBeUndefined();

    const cleared = OrderUpdateSchema.parse({ version: 2, shippingAddress: '   ', notes: null });
    expect(cleared.shippingAddress).toBeNull();
    expect(cleared.notes).toBeNull();
  });

  // covers AC-19: an omitted delivery deadline is unchanged while a blank or null clears it
  it('keeps an omitted delivery deadline absent and clears it on blank or null', () => {
    expect(OrderUpdateSchema.parse({ version: 2 }).deliveryDeadline).toBeUndefined();
    expect(
      OrderUpdateSchema.parse({ version: 2, deliveryDeadline: '' }).deliveryDeadline,
    ).toBeNull();
    expect(
      OrderUpdateSchema.parse({ version: 2, deliveryDeadline: null }).deliveryDeadline,
    ).toBeNull();
    expect(
      OrderUpdateSchema.parse({ version: 2, deliveryDeadline: '2026-11-05' }).deliveryDeadline,
    ).toBe('2026-11-05');
    expect(
      OrderUpdateSchema.safeParse({ version: 2, deliveryDeadline: '2026-02-30' }).success,
    ).toBe(false);
  });

  // covers AC-11: the edit limit is measured after trimming too
  it('measures the 500 character limit after trimming on edit', () => {
    const address = 'a'.repeat(500);
    const parsed = OrderUpdateSchema.parse({ version: 2, shippingAddress: `${address}   ` });

    expect(parsed.shippingAddress).toBe(address);
    expect(
      OrderUpdateSchema.safeParse({ version: 2, notes: `${'a'.repeat(501)}   ` }).success,
    ).toBe(false);
  });

  // covers AC-4 and AC-11: edit money and identifiers obey the same rules as create
  it.each<[string, Record<string, unknown>]>([
    ['a negative delivery fee', { deliveryFee: -1 }],
    ['a fractional delivery fee', { deliveryFee: 10.5 }],
    ['a delivery fee above the cap', { deliveryFee: 100_000_001 }],
    ['a negative discount', { discount: -1 }],
    ['a fractional discount', { discount: 10.5 }],
    ['a discount above the cap', { discount: 100_000_001 }],
    [
      'a unit price above the cap',
      { items: [{ productId: PRODUCT_ID, quantity: 1, unitPrice: 100_000_001 }] },
    ],
    ['an empty line list', { items: [] }],
    ['an unknown source', { source: 'CARRIER_PIGEON' }],
    ['a customer id that is not a UUID', { customerId: 'customer-1' }],
  ])('rejects %s on edit', (_label, overrides) => {
    expect(OrderUpdateSchema.safeParse({ version: 2, ...overrides }).success).toBe(false);
  });

  // covers AC-4 and AC-11: the edit money cap is inclusive
  it('accepts a delivery fee and discount at the cap on edit', () => {
    const parsed = OrderUpdateSchema.parse({
      version: 2,
      deliveryFee: 100_000_000,
      discount: 100_000_000,
    });

    expect(parsed.deliveryFee).toBe(100_000_000);
    expect(parsed.discount).toBe(100_000_000);
  });

  // covers AC-9: an edit carries a version and may identify an existing line
  it('requires a positive version and accepts a line id', () => {
    const parsed = OrderUpdateSchema.parse({
      version: 3,
      items: [{ lineId: LINE_ID, productId: PRODUCT_ID, quantity: 2 }],
    });

    expect(parsed.version).toBe(3);
    expect(parsed.items?.[0].lineId).toBe(LINE_ID);

    expect(OrderUpdateSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(OrderUpdateSchema.safeParse({ version: 1.5 }).success).toBe(false);
  });

  // covers AC-9 and AC-11: edit rows merge before the 50 line limit is checked
  it('accepts more than 50 raw edit rows when they merge into one line', () => {
    const items = Array.from({ length: 60 }, () => ({
      productId: PRODUCT_ID,
      quantity: 1,
      unitPrice: 100,
    }));

    expect(OrderUpdateSchema.safeParse({ version: 2, items }).success).toBe(true);
  });

  // covers AC-9 and AC-11: the edit payload has the same raw row cap as create
  it('rejects an edit line list above the raw payload cap', () => {
    const items = Array.from({ length: 201 }, () => ({
      productId: PRODUCT_ID,
      quantity: 1,
    }));

    const parsed = OrderUpdateSchema.safeParse({ version: 2, items });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('items');
    }
  });

  // covers AC-9: the edit payload has no status field
  it('drops a status field sent with an edit', () => {
    const parsed = OrderUpdateSchema.parse({ version: 1, status: 'DELIVERED' });

    expect('status' in parsed).toBe(false);
  });

  // covers AC-9: a line id has to be a UUID
  it('rejects a line id that is not a UUID', () => {
    const parsed = OrderUpdateSchema.safeParse({
      version: 1,
      items: [{ lineId: 'line-1', productId: PRODUCT_ID, quantity: 1 }],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('order status change contract', () => {
  // covers AC-10: every status can be named, and the note is trimmed
  it('accepts each order status and trims the note', () => {
    for (const status of ORDER_STATUSES) {
      const parsed = OrderStatusChangeSchema.parse({ status, version: 1, note: '  called  ' });
      expect(parsed.status).toBe(status);
      expect(parsed.note).toBe('called');
    }
  });

  // covers AC-10: a blank or null note means no note
  it('stores a blank or null note as null', () => {
    expect(
      OrderStatusChangeSchema.parse({ status: 'CONFIRMED', version: 1, note: '   ' }).note,
    ).toBeNull();
    expect(
      OrderStatusChangeSchema.parse({ status: 'CONFIRMED', version: 1, note: null }).note,
    ).toBeNull();
  });

  // covers AC-11: the status note limit is measured after trimming
  it('measures the status note limit after trimming', () => {
    const note = 'a'.repeat(200);
    const parsed = OrderStatusChangeSchema.parse({
      status: 'CONFIRMED',
      version: 1,
      note: `${note}   `,
    });

    expect(parsed.note).toBe(note);
    expect(
      OrderStatusChangeSchema.safeParse({
        status: 'CONFIRMED',
        version: 1,
        note: `${'a'.repeat(201)}   `,
      }).success,
    ).toBe(false);
  });

  // covers AC-11: the status note limit is 200 characters
  it('rejects a status note above 200 characters', () => {
    expect(
      OrderStatusChangeSchema.safeParse({
        status: 'CONFIRMED',
        version: 1,
        note: 'a'.repeat(201),
      }).success,
    ).toBe(false);
  });

  // covers AC-10: an unknown status and a missing version are rejected
  it('rejects an unknown status and a missing version', () => {
    expect(OrderStatusChangeSchema.safeParse({ status: 'ARCHIVED', version: 1 }).success).toBe(
      false,
    );
    expect(OrderStatusChangeSchema.safeParse({ status: 'CONFIRMED' }).success).toBe(false);
  });
});

describe('order response contracts', () => {
  it('parses a full order with its lines and timeline', () => {
    const parsed = OrderSchema.parse({
      id: 'order-1',
      orderNumber: 'ORD-0001',
      status: 'PENDING',
      source: 'FACEBOOK',
      customerId: CUSTOMER_ID,
      customerName: 'Nusrat Jahan',
      customerPhone: '+8801712345678',
      shippingAddress: null,
      notes: null,
      deliveryDeadline: null,
      subtotal: 2500,
      deliveryFee: 100,
      discount: 50,
      total: 2550,
      paidAmount: 0,
      dueAmount: 2550,
      refundOwed: 0,
      paymentStatus: 'UNPAID',
      version: 1,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
      items: [
        {
          id: LINE_ID,
          productId: PRODUCT_ID,
          variantId: null,
          productName: 'Cotton shirt',
          variantLabel: null,
          price: 2500,
          cost: 1500,
          quantity: 1,
          subtotal: 2500,
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
          createdAt: '2026-10-20T10:00:00.000Z',
        },
      ],
      payments: [],
    });

    expect(parsed.orderNumber).toBe('ORD-0001');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.history[0].fromStatus).toBeNull();
    expect(parsed.payments).toEqual([]);
  });

  it('parses a list page with and without a next cursor', () => {
    const row = {
      id: 'order-1',
      orderNumber: 'ORD-0001',
      status: 'PENDING',
      customerName: 'Nusrat Jahan',
      total: 2550,
      paidAmount: 0,
      dueAmount: 2550,
      refundOwed: 0,
      paymentStatus: 'UNPAID',
      source: null,
      deliveryDeadline: null,
      itemCount: 1,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    };

    expect(OrderPageSchema.parse({ items: [row], nextCursor: null }).items).toHaveLength(1);
    expect(OrderPageSchema.parse({ items: [], nextCursor: 'abc' }).nextCursor).toBe('abc');
  });

  // covers the response contract: timestamps stay ISO strings, so reject a
  // stored value that would not survive JSON date serialization
  it('rejects order timestamps that are not ISO 8601', () => {
    const row = {
      id: 'order-1',
      orderNumber: 'ORD-0001',
      status: 'PENDING',
      customerName: 'Nusrat Jahan',
      total: 2550,
      paidAmount: 0,
      dueAmount: 2550,
      refundOwed: 0,
      paymentStatus: 'UNPAID',
      source: null,
      deliveryDeadline: null,
      itemCount: 1,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    };

    expect(OrderSummarySchema.safeParse(row).success).toBe(true);
    expect(OrderSummarySchema.safeParse({ ...row, createdAt: '2026-10-20' }).success).toBe(false);
    expect(OrderSummarySchema.safeParse({ ...row, updatedAt: 'not-a-date' }).success).toBe(false);
  });

  it('requires the existing order in a duplicate error', () => {
    const message = 'A similar order was created in the last 24 hours';
    const existingOrder = {
      id: 'order-9',
      orderNumber: 'ORD-0009',
      status: 'PENDING',
      total: 5000,
      createdAt: '2026-10-20T10:00:00.000Z',
    };

    expect(
      DuplicateOrderErrorSchema.safeParse({
        error: 'DUPLICATE_ORDER',
        message,
        existingOrder,
      }).success,
    ).toBe(true);
    expect(DuplicateOrderErrorSchema.safeParse({ error: 'DUPLICATE_ORDER', message }).success).toBe(
      false,
    );
  });

  // covers AC-1 and AC-7: the shared enums carry every status and source
  it('exposes every status and source in canonical order', () => {
    expect(ORDER_STATUSES).toEqual([
      'PENDING',
      'CONFIRMED',
      'PROCESSING',
      'SHIPPED',
      'DELIVERED',
      'CANCELLED',
      'RETURNED',
    ]);
    expect(ORDER_SOURCES).toEqual([
      'FACEBOOK',
      'WHATSAPP',
      'INSTAGRAM',
      'TIKTOK',
      'DIRECT',
      'OTHER',
    ]);
  });
});
