import { describe, expect, it } from 'vitest';
import { PaymentKind } from './entities/financial.entity.js';
import { OrderStatus } from './entities/order.entity.js';
import {
  OrderClosedError,
  PaymentAlreadyVoidedError,
  PaymentExceedsDueError,
  RefundExceedsPaidError,
  TotalBelowPaidError,
  VoidBreaksBalanceError,
} from './errors.js';
import {
  assertCanRecordPayment,
  assertCanRecordRefund,
  assertCanVoidPayment,
  assertTotalCoversPaid,
  computeOrderBalance,
  derivePaymentStatus,
  deriveRefundOwed,
  isMethodAllowedForCurrency,
} from './order-payments.js';

describe('order payments domain rules', () => {
  // covers spec 0010 AC-10: derived payment status across active and closed states
  it('derives paymentStatus for every active and closed order state', () => {
    expect(derivePaymentStatus(OrderStatus.PENDING, 1000, 0)).toBe('UNPAID');
    expect(derivePaymentStatus(OrderStatus.CONFIRMED, 1000, 400)).toBe('PARTIAL');
    expect(derivePaymentStatus(OrderStatus.DELIVERED, 1000, 1000)).toBe('PAID');
    expect(derivePaymentStatus(OrderStatus.PENDING, 0, 0)).toBe('PAID');

    expect(derivePaymentStatus(OrderStatus.CANCELLED, 1000, 400)).toBe('REFUND_OWED');
    expect(derivePaymentStatus(OrderStatus.RETURNED, 1000, 100)).toBe('REFUND_OWED');
    expect(derivePaymentStatus(OrderStatus.CANCELLED, 1000, 0)).toBe('NONE');
    expect(derivePaymentStatus(OrderStatus.RETURNED, 0, 0)).toBe('NONE');
  });

  // covers spec 0010 AC-7: recomputes balance ignoring voided entries
  it('computes net paid, due, refundOwed, and paymentStatus from ledger entries', () => {
    const entries = [
      { kind: PaymentKind.PAYMENT, amount: 700, voidedAt: undefined },
      { kind: PaymentKind.PAYMENT, amount: 500, voidedAt: new Date('2026-11-26T00:00:00.000Z') },
      { kind: PaymentKind.REFUND, amount: 200, voidedAt: undefined },
    ];

    expect(computeOrderBalance(OrderStatus.CONFIRMED, 1200, entries)).toEqual({
      paidAmount: 500,
      dueAmount: 700,
      refundOwed: 0,
      paymentStatus: 'PARTIAL',
    });

    expect(computeOrderBalance(OrderStatus.CANCELLED, 1200, entries)).toEqual({
      paidAmount: 500,
      dueAmount: 0,
      refundOwed: 500,
      paymentStatus: 'REFUND_OWED',
    });

    expect(deriveRefundOwed(OrderStatus.SHIPPED, 500)).toBe(0);
    expect(deriveRefundOwed(OrderStatus.RETURNED, 500)).toBe(500);
  });

  // covers spec 0010 AC-4: closed order and due ceiling guards
  it('enforces record payment status and due bounds', () => {
    expect(() => assertCanRecordPayment(OrderStatus.DELIVERED, 500, 500)).not.toThrow();
    expect(() => assertCanRecordPayment(OrderStatus.CANCELLED, 0, 100)).toThrow(OrderClosedError);
    expect(() => assertCanRecordPayment(OrderStatus.RETURNED, 0, 100)).toThrow(OrderClosedError);

    try {
      assertCanRecordPayment(OrderStatus.PENDING, 300, 301);
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentExceedsDueError);
      expect((error as PaymentExceedsDueError).dueAmount).toBe(300);
    }
  });

  // covers spec 0010 AC-5: refund ceiling guard
  it('enforces refund paid ceiling', () => {
    expect(() => assertCanRecordRefund(500, 500)).not.toThrow();
    try {
      assertCanRecordRefund(200, 201);
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(RefundExceedsPaidError);
      expect((error as RefundExceedsPaidError).paidAmount).toBe(200);
    }
  });

  // covers spec 0010 AC-6: void guard holds in both active and closed orders
  it('enforces void guards against double void, negative paid, and paid above total', () => {
    expect(() =>
      assertCanVoidPayment(1000, 600, {
        kind: PaymentKind.PAYMENT,
        amount: 600,
        voidedAt: new Date(),
      }),
    ).toThrow(PaymentAlreadyVoidedError);

    // Voiding a payment that a refund depends on would make paid negative (-400).
    try {
      assertCanVoidPayment(1000, 600, {
        kind: PaymentKind.PAYMENT,
        amount: 1000,
        voidedAt: undefined,
      });
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VoidBreaksBalanceError);
      expect((error as VoidBreaksBalanceError).paidAmount).toBe(600);
      expect((error as VoidBreaksBalanceError).total).toBe(1000);
    }

    // Voiding a 400 refund after total dropped to 700 (even on a cancelled order)
    // would push paid to 1000 > 700 and must be blocked with 409, never 500.
    try {
      assertCanVoidPayment(700, 600, {
        kind: PaymentKind.REFUND,
        amount: 400,
        voidedAt: undefined,
      });
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VoidBreaksBalanceError);
      expect((error as VoidBreaksBalanceError).paidAmount).toBe(600);
      expect((error as VoidBreaksBalanceError).total).toBe(700);
    }

    expect(() =>
      assertCanVoidPayment(1000, 600, {
        kind: PaymentKind.REFUND,
        amount: 400,
        voidedAt: undefined,
      }),
    ).not.toThrow();
  });

  // covers spec 0010 AC-9 & AC-13: edit total guard and currency method check
  it('enforces edit total above paid and BD-only method restriction', () => {
    expect(() => assertTotalCoversPaid(500, 500)).not.toThrow();
    expect(() => assertTotalCoversPaid(499, 500)).toThrow(TotalBelowPaidError);

    expect(isMethodAllowedForCurrency('BKASH', 'BDT')).toBe(true);
    expect(isMethodAllowedForCurrency('NAGAD', 'BDT')).toBe(true);
    expect(isMethodAllowedForCurrency('BKASH', 'USD')).toBe(false);
    expect(isMethodAllowedForCurrency('NAGAD', 'EUR')).toBe(false);
    expect(isMethodAllowedForCurrency('CASH_ON_DELIVERY', 'USD')).toBe(true);
  });
});
