import { describe, expect, it } from 'vitest';
import { PaymentKind, PaymentMethod } from './entities/financial.entity.js';
import {
  PAYMENT_DEFAULT_PAGE_SIZE,
  PAYMENT_MAX_PAGE_SIZE,
  decodePaymentLedgerCursor,
  encodePaymentLedgerCursor,
  paymentMethodKey,
} from './payment-cursor.js';

const PAYMENT_ID = '00000000-0000-0000-0000-0000000000a9';
const CREATED_AT = new Date('2026-11-26T10:00:00.000Z');

describe('payment ledger cursor', () => {
  // covers spec 0010 AC-17: canonical method key and plain normalized filter round trip
  it('round-trips sort keys and plain normalized filters', () => {
    expect(paymentMethodKey([PaymentMethod.NAGAD, PaymentMethod.BKASH, PaymentMethod.NAGAD])).toBe(
      'BKASH,NAGAD',
    );
    expect(PAYMENT_DEFAULT_PAGE_SIZE).toBe(20);
    expect(PAYMENT_MAX_PAGE_SIZE).toBe(50);

    const cursor = encodePaymentLedgerCursor({
      paymentDate: '2026-11-25',
      createdAt: CREATED_AT,
      id: PAYMENT_ID,
      from: '2026-11-01',
      to: '2026-11-26',
      methods: 'BKASH,CASH',
      kind: PaymentKind.PAYMENT,
      limit: 20,
    });

    expect(
      decodePaymentLedgerCursor(cursor, {
        from: '2026-11-01',
        to: '2026-11-26',
        methods: 'BKASH,CASH',
        kind: PaymentKind.PAYMENT,
        limit: 20,
      }),
    ).toEqual({
      paymentDate: '2026-11-25',
      createdAt: CREATED_AT,
      id: PAYMENT_ID,
      from: '2026-11-01',
      to: '2026-11-26',
      methods: 'BKASH,CASH',
      kind: PaymentKind.PAYMENT,
      limit: 20,
    });
  });

  // covers spec 0010 AC-17: rejects replay against changed filters or malformed input
  it('rejects changed filters and malformed cursors', () => {
    const cursor = encodePaymentLedgerCursor({
      paymentDate: '2026-11-25',
      createdAt: CREATED_AT,
      id: PAYMENT_ID,
      from: '2026-11-01',
      to: '2026-11-26',
      methods: 'BKASH',
      kind: '',
      limit: 20,
    });

    const base = {
      from: '2026-11-01',
      to: '2026-11-26',
      methods: 'BKASH',
      kind: '' as const,
      limit: 20,
    };

    expect(decodePaymentLedgerCursor(cursor, { ...base, from: '2026-11-02' })).toBeNull();
    expect(decodePaymentLedgerCursor(cursor, { ...base, to: '2026-11-27' })).toBeNull();
    expect(decodePaymentLedgerCursor(cursor, { ...base, methods: 'CASH' })).toBeNull();
    expect(decodePaymentLedgerCursor(cursor, { ...base, kind: PaymentKind.REFUND })).toBeNull();
    expect(decodePaymentLedgerCursor(cursor, { ...base, limit: 10 })).toBeNull();
    expect(decodePaymentLedgerCursor('not!valid', base)).toBeNull();
  });
});
