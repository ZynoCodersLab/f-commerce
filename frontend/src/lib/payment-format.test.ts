import {
  MAX_PAYMENT_AMOUNT,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  TRANSACTION_ID_PAYMENT_METHODS,
  type OrderStatusType,
  type PaymentMethodType,
} from '@f-commerce/contracts';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  PAYMENT_STATUS_TONE,
  isCardMethod,
  isOrderClosedForPayment,
  parsePaymentAmountInput,
  paymentReferenceLabel,
} from './payment-format';

describe('payment format helpers', () => {
  // covers spec 0010 AC-10 and AC-13: every contract method, kind, and status has a readable label and tone
  it('defines labels and tones for every contract method, kind, and payment status', () => {
    for (const method of PAYMENT_METHODS) {
      expect(PAYMENT_METHOD_LABEL[method].trim().length).toBeGreaterThan(0);
    }
    for (const kind of PAYMENT_KINDS) {
      expect(PAYMENT_KIND_LABEL[kind].trim().length).toBeGreaterThan(0);
    }
    for (const status of PAYMENT_STATUSES) {
      expect(PAYMENT_STATUS_LABEL[status].trim().length).toBeGreaterThan(0);
      expect(PAYMENT_STATUS_TONE[status].trim().length).toBeGreaterThan(0);
    }
  });

  // covers spec 0010 AC-18: reference label switches to Transaction ID for electronic/card methods
  it('switches reference label between Transaction ID and Reference across all 8 methods', () => {
    for (const method of PAYMENT_METHODS) {
      const expected = (TRANSACTION_ID_PAYMENT_METHODS as readonly string[]).includes(method)
        ? 'Transaction ID (optional)'
        : 'Reference (optional)';
      expect(paymentReferenceLabel(method)).toBe(expected);
    }
  });

  // covers spec 0010 AC-18: card warning helper flags CARD only
  it('identifies CARD as the only method needing the card number reminder', () => {
    const others: PaymentMethodType[] = PAYMENT_METHODS.filter((method) => method !== 'CARD');
    expect(isCardMethod('CARD')).toBe(true);
    for (const method of others) {
      expect(isCardMethod(method)).toBe(false);
    }
  });

  // covers spec 0010 AC-4: only CANCELLED and RETURNED orders are closed to new payments
  it('detects closed order statuses accurately', () => {
    const openStatuses: OrderStatusType[] = [
      'PENDING',
      'CONFIRMED',
      'PROCESSING',
      'SHIPPED',
      'DELIVERED',
    ];
    for (const status of openStatuses) {
      expect(isOrderClosedForPayment(status)).toBe(false);
    }
    expect(isOrderClosedForPayment('CANCELLED')).toBe(true);
    expect(isOrderClosedForPayment('RETURNED')).toBe(true);
  });

  // covers spec 0010 AC-14 and AC-18: whole-unit integer parser enforces [1, MAX_PAYMENT_AMOUNT]
  it('parses valid whole payment amounts and rejects empty, zero, negative, fractional, and oversized input', () => {
    expect(parsePaymentAmountInput('1')).toBe(1);
    expect(parsePaymentAmountInput(` ${MAX_PAYMENT_AMOUNT} `)).toBe(MAX_PAYMENT_AMOUNT);

    for (const bad of ['', '   ', '0', '-5', '12.5', String(MAX_PAYMENT_AMOUNT + 1), 'abc']) {
      expect(parsePaymentAmountInput(bad)).toBeNull();
    }
  });
});
