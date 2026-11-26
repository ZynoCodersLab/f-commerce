import { describe, expect, it } from 'vitest';
import { OrderStatus } from './entities/order.entity.js';
import {
  ORDER_DEFAULT_PAGE_SIZE,
  ORDER_MAX_PAGE_SIZE,
  decodeOrderListCursor,
  encodeOrderListCursor,
  orderPaymentStatusKey,
  orderStatusKey,
} from './order-cursor.js';

const ORDER_ID = '00000000-0000-0000-0000-0000000000f1';
const CREATED_AT = new Date('2026-03-01T10:00:00.000Z');

function rawCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function encoded(overrides: Partial<Parameters<typeof encodeOrderListCursor>[0]> = {}): string {
  return encodeOrderListCursor({
    createdAt: CREATED_AT,
    id: ORDER_ID,
    statuses: 'PENDING',
    paymentStatuses: '',
    q: '',
    limit: 20,
    ...overrides,
  });
}

describe('orderStatusKey', () => {
  // covers AC-7: the status set is canonical, so a repeated status cannot change the cursor
  it('sorts and removes duplicate statuses', () => {
    expect(orderStatusKey([OrderStatus.SHIPPED, OrderStatus.PENDING, OrderStatus.SHIPPED])).toBe(
      'PENDING,SHIPPED',
    );
    expect(orderStatusKey([])).toBe('');
  });
});

describe('orderPaymentStatusKey', () => {
  // covers spec 0010 AC-10: payment status filter sets are canonicalized for cursor binding
  it('sorts and removes duplicate payment statuses', () => {
    expect(orderPaymentStatusKey(['UNPAID', 'PARTIAL', 'UNPAID'])).toBe('PARTIAL,UNPAID');
    expect(orderPaymentStatusKey([])).toBe('');
  });
});

describe('order list cursor', () => {
  // covers AC-7 and spec 0010 AC-10: the cursor round-trips when query and page size match
  it('round-trips the sort key with the same filter, payment filter, search, and limit', () => {
    const cursor = encoded({ paymentStatuses: 'PARTIAL,UNPAID', q: 'nusrat', limit: 10 });

    expect(decodeOrderListCursor(cursor, 'PENDING', 'PARTIAL,UNPAID', 'nusrat', 10)).toEqual({
      createdAt: CREATED_AT,
      id: ORDER_ID,
      statuses: 'PENDING',
      paymentStatuses: 'PARTIAL,UNPAID',
      q: 'nusrat',
      limit: 10,
    });
  });

  // covers AC-7: a cursor cannot be replayed against a different status set
  it('rejects a cursor built for a different status set', () => {
    const cursor = encoded({ statuses: 'PENDING' });

    expect(decodeOrderListCursor(cursor, 'PENDING,CONFIRMED', '', '', 20)).toBeNull();
  });

  // covers spec 0010 AC-10: a cursor cannot be replayed against a different payment status set
  it('rejects a cursor built for a different payment status set', () => {
    const cursor = encoded({ paymentStatuses: 'UNPAID' });

    expect(decodeOrderListCursor(cursor, 'PENDING', 'PARTIAL', '', 20)).toBeNull();
    expect(decodeOrderListCursor(cursor, 'PENDING', '', '', 20)).toBeNull();
  });

  // covers AC-7: a cursor cannot be replayed against a different search
  it('rejects a cursor built for a different search', () => {
    const cursor = encoded({ q: 'nusrat' });

    expect(decodeOrderListCursor(cursor, 'PENDING', '', 'tanvir', 20)).toBeNull();
  });

  // covers AC-7: a cursor cannot be replayed with a different page size
  it('rejects a cursor built for a different page size', () => {
    const cursor = encoded({ limit: 20 });

    expect(decodeOrderListCursor(cursor, 'PENDING', '', '', 10)).toBeNull();
  });

  // covers AC-7: the sort key id has to be a UUID
  it('rejects a sort key id that is not a UUID', () => {
    const cursor = encoded({ id: 'order-1' });

    expect(decodeOrderListCursor(cursor, 'PENDING', '', '', 20)).toBeNull();
  });

  // covers AC-7: a malformed or tampered cursor is refused
  it('rejects input that is not base64url and content that is not JSON', () => {
    expect(decodeOrderListCursor('not valid!', '', '', '', 20)).toBeNull();
    expect(decodeOrderListCursor('abc+def/', '', '', '', 20)).toBeNull();
    expect(
      decodeOrderListCursor(
        Buffer.from('hello there', 'utf8').toString('base64url'),
        '',
        '',
        '',
        20,
      ),
    ).toBeNull();
  });

  it('rejects JSON that is not an object', () => {
    expect(decodeOrderListCursor(rawCursor([1, 2]), '', '', '', 20)).toBeNull();
    expect(decodeOrderListCursor(rawCursor(null), '', '', '', 20)).toBeNull();
    expect(decodeOrderListCursor(rawCursor('cursor'), '', '', '', 20)).toBeNull();
  });

  it('rejects a payload with a wrong field type', () => {
    expect(
      decodeOrderListCursor(
        rawCursor({ createdAt: 1714000000000, _id: ORDER_ID, statuses: '', q: '', limit: 20 }),
        '',
        '',
        '',
        20,
      ),
    ).toBeNull();
    expect(
      decodeOrderListCursor(
        rawCursor({
          createdAt: CREATED_AT.toISOString(),
          _id: ORDER_ID,
          statuses: 1,
          q: '',
          limit: 20,
        }),
        '1',
        '',
        '',
        20,
      ),
    ).toBeNull();
    expect(
      decodeOrderListCursor(
        rawCursor({
          createdAt: CREATED_AT.toISOString(),
          _id: ORDER_ID,
          statuses: '',
          q: '',
          limit: '20',
        }),
        '',
        '',
        '',
        20,
      ),
    ).toBeNull();
  });

  it('rejects an unparseable date and a missing id', () => {
    expect(
      decodeOrderListCursor(
        rawCursor({ createdAt: 'not-a-date', _id: ORDER_ID, statuses: '', q: '', limit: 20 }),
        '',
        '',
        '',
        20,
      ),
    ).toBeNull();
    expect(
      decodeOrderListCursor(
        rawCursor({ createdAt: CREATED_AT.toISOString(), statuses: '', q: '', limit: 20 }),
        '',
        '',
        '',
        20,
      ),
    ).toBeNull();
  });

  // covers AC-7: the list reads 20 rows by default and never more than 50
  it('exposes the documented page sizes', () => {
    expect(ORDER_DEFAULT_PAGE_SIZE).toBe(20);
    expect(ORDER_MAX_PAGE_SIZE).toBe(50);
  });
});
