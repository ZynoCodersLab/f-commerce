import { describe, expect, it } from 'vitest';
import {
  availablePaymentMethods,
  BD_ONLY_PAYMENT_METHODS,
  InitialPaymentSchema,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_STATUS_FILTER_VALUES,
  PAYMENT_STATUSES,
  PaymentCreateSchema,
  PaymentEntrySchema,
  PaymentLedgerPageSchema,
  PaymentLedgerQuerySchema,
  PaymentLedgerSummarySchema,
  PaymentStatusFilterSchema,
  PaymentVoidSchema,
} from './index.js';

describe('payment contracts', () => {
  // covers spec 0010 AC-13: bKash and Nagad are available only for BDT businesses
  it('filters BD-only methods by business currency', () => {
    expect(availablePaymentMethods('BDT')).toEqual(PAYMENT_METHODS);
    expect(availablePaymentMethods('USD')).toEqual(
      PAYMENT_METHODS.filter((m) => !(BD_ONLY_PAYMENT_METHODS as readonly string[]).includes(m)),
    );
    expect(availablePaymentMethods('EUR')).not.toContain('BKASH');
    expect(availablePaymentMethods('GBP')).not.toContain('NAGAD');
  });

  // covers spec 0010 AC-14: positive integer bounds, trimming, and optional date normalization
  it('normalizes optional text and date on payment create', () => {
    const parsed = PaymentCreateSchema.parse({
      amount: 500,
      method: 'BKASH',
      paymentDate: '  ',
      referenceNumber: '  TRX123  ',
      notes: '   ',
    });

    expect(parsed).toEqual({
      amount: 500,
      method: 'BKASH',
      paymentDate: null,
      referenceNumber: 'TRX123',
      notes: null,
    });
  });

  // covers spec 0010 AC-14: inclusive boundaries for amount, referenceNumber, and notes
  it('accepts exact inclusive bounds on payment create', () => {
    const minValid = PaymentCreateSchema.parse({
      amount: 1,
      method: 'CASH',
    });
    expect(minValid.amount).toBe(1);

    const maxValid = PaymentCreateSchema.parse({
      amount: 100_000_000,
      method: 'OTHER',
      referenceNumber: 'r'.repeat(100),
      notes: 'n'.repeat(500),
      paymentDate: '2026-11-26',
    });
    expect(maxValid.amount).toBe(100_000_000);
    expect(maxValid.referenceNumber).toHaveLength(100);
    expect(maxValid.notes).toHaveLength(500);
  });

  // covers spec 0010 AC-14: rejects invalid amounts, dates, and lengths
  it.each<[string, Record<string, unknown>]>([
    ['zero amount', { amount: 0, method: 'CASH' }],
    ['negative amount', { amount: -10, method: 'CASH' }],
    ['fractional amount', { amount: 12.5, method: 'CASH' }],
    ['amount above cap', { amount: 100_000_001, method: 'CASH' }],
    ['unknown method', { amount: 100, method: 'CRYPTO' }],
    ['impossible date', { amount: 100, method: 'CASH', paymentDate: '2026-02-30' }],
    ['reference over 100 chars', { amount: 100, method: 'CASH', referenceNumber: 'a'.repeat(101) }],
    ['notes over 500 chars', { amount: 100, method: 'CASH', notes: 'a'.repeat(501) }],
  ])('rejects %s', (_label, payload) => {
    expect(PaymentCreateSchema.safeParse(payload).success).toBe(false);
  });

  // covers spec 0010 AC-1 and AC-2: optional initialPayment accepts CASH_ON_DELIVERY and rejects invalid inputs
  it('validates initialPayment including CASH_ON_DELIVERY and rejects invalid shapes', () => {
    expect(
      InitialPaymentSchema.parse({
        amount: 1200,
        method: 'CASH_ON_DELIVERY',
      }),
    ).toEqual({
      amount: 1200,
      method: 'CASH_ON_DELIVERY',
      paymentDate: null,
      referenceNumber: null,
      notes: null,
    });
    expect(InitialPaymentSchema.safeParse({ amount: 0, method: 'CASH' }).success).toBe(false);
    expect(InitialPaymentSchema.safeParse({ amount: 100, method: 'INVALID' }).success).toBe(false);
  });

  // covers spec 0010 AC-6: void requires trimmed non-empty reason up to 200 chars
  it('validates void reason bounds including 1 and 200 character extremes', () => {
    expect(PaymentVoidSchema.parse({ reason: 'x' })).toEqual({ reason: 'x' });
    expect(PaymentVoidSchema.parse({ reason: '  Wrong amount  ' })).toEqual({
      reason: 'Wrong amount',
    });
    expect(PaymentVoidSchema.parse({ reason: 'v'.repeat(200) }).reason).toHaveLength(200);
    expect(PaymentVoidSchema.safeParse({ reason: '   ' }).success).toBe(false);
    expect(PaymentVoidSchema.safeParse({ reason: 'a'.repeat(201) }).success).toBe(false);
  });

  // covers spec 0010 AC-10: NONE is a response status, not a filter value
  it('excludes NONE from payment status filter values', () => {
    expect(PAYMENT_STATUSES).toContain('NONE');
    expect(PAYMENT_STATUS_FILTER_VALUES).not.toContain('NONE');
    expect(PaymentStatusFilterSchema.safeParse('NONE').success).toBe(false);
    expect(PaymentStatusFilterSchema.safeParse('REFUND_OWED').success).toBe(true);
  });

  // covers spec 0010 AC-11 and AC-17: entry (including refund & void fields) and ledger query/summary schemas
  it('parses payment and voided refund entries, ledger queries, and negative net summaries', () => {
    const entry = {
      id: 'pay-1',
      kind: 'PAYMENT' as const,
      amount: 500,
      method: 'BKASH' as const,
      referenceNumber: 'TRX-1',
      notes: 'Advance',
      paymentDate: '2026-11-26',
      recordedByName: 'Maya Owner',
      createdAt: '2026-11-26T10:00:00.000Z',
      voidedAt: null,
      voidedByName: null,
      voidReason: null,
    };

    const voidedRefund = {
      id: 'pay-2',
      kind: 'REFUND' as const,
      amount: 200,
      method: 'CASH' as const,
      referenceNumber: null,
      notes: null,
      paymentDate: '2026-11-26',
      recordedByName: 'Maya Owner',
      createdAt: '2026-11-26T11:00:00.000Z',
      voidedAt: '2026-11-26T11:30:00.000Z',
      voidedByName: 'Maya Owner',
      voidReason: 'Entered twice',
    };

    expect(PaymentEntrySchema.parse(entry)).toEqual(entry);
    expect(PaymentEntrySchema.parse(voidedRefund)).toEqual(voidedRefund);
    expect(
      PaymentLedgerPageSchema.parse({
        items: [{ ...entry, orderId: 'ord-1', orderNumber: 'ORD-0001', customerName: 'Nusrat' }],
        summary: { collected: 500, refunded: 0, net: 500 },
        nextCursor: null,
      }).items,
    ).toHaveLength(1);

    expect(PaymentLedgerSummarySchema.parse({ collected: 0, refunded: 300, net: -300 })).toEqual({
      collected: 0,
      refunded: 300,
      net: -300,
    });

    expect(
      PaymentLedgerQuerySchema.parse({
        from: '2026-11-01',
        to: '2026-11-26',
        method: 'BKASH,CASH',
        kind: 'REFUND',
        limit: 20,
      }),
    ).toEqual({
      from: '2026-11-01',
      to: '2026-11-26',
      method: 'BKASH,CASH',
      kind: 'REFUND',
      limit: 20,
    });
    expect(PaymentLedgerQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(PaymentLedgerQuerySchema.safeParse({ kind: 'VOID' }).success).toBe(false);
    expect(PaymentLedgerQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(PAYMENT_KINDS).toEqual(['PAYMENT', 'REFUND']);
  });
});
