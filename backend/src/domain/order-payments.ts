import {
  availablePaymentMethods,
  PaymentMethodType,
  PaymentStatusType,
} from '@f-commerce/contracts';
import { Payment, PaymentKind } from './entities/financial.entity.js';
import { OrderStatus } from './entities/order.entity.js';
import {
  OrderClosedError,
  PaymentAlreadyVoidedError,
  PaymentExceedsDueError,
  RefundExceedsPaidError,
  TotalBelowPaidError,
  VoidBreaksBalanceError,
} from './errors.js';

/** Order statuses where the sale is closed and no new payment may be recorded. */
export const CLOSED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
];

export function isOrderClosedForPayment(status: OrderStatus): boolean {
  return CLOSED_ORDER_STATUSES.includes(status);
}

/** Money still held on a cancelled or returned order; always 0 on active orders. */
export function deriveRefundOwed(status: OrderStatus, paidAmount: number): number {
  return isOrderClosedForPayment(status) ? paidAmount : 0;
}

/**
 * Derive an order's payment status from its status, total, and net paid amount.
 * Must stay identical to the SQL `CASE` used by the `GET /api/orders` filter.
 */
export function derivePaymentStatus(
  status: OrderStatus,
  total: number,
  paidAmount: number,
): PaymentStatusType {
  if (isOrderClosedForPayment(status)) {
    return paidAmount > 0 ? 'REFUND_OWED' : 'NONE';
  }
  if (paidAmount >= total) {
    return 'PAID';
  }
  if (paidAmount === 0) {
    return 'UNPAID';
  }
  return 'PARTIAL';
}

export interface OrderBalance {
  paidAmount: number;
  dueAmount: number;
  refundOwed: number;
  paymentStatus: PaymentStatusType;
}

/** Recompute an order's net paid, due, refund owed, and payment status from its ledger entries. */
export function computeOrderBalance(
  status: OrderStatus,
  total: number,
  entries: readonly Pick<Payment, 'kind' | 'amount' | 'voidedAt'>[],
): OrderBalance {
  let paidAmount = 0;
  for (const entry of entries) {
    if (entry.voidedAt !== undefined) continue;
    paidAmount += entry.kind === PaymentKind.PAYMENT ? entry.amount : -entry.amount;
  }

  const closed = isOrderClosedForPayment(status);
  const dueAmount = closed ? 0 : total - paidAmount;
  const refundOwed = closed ? paidAmount : 0;
  const paymentStatus = derivePaymentStatus(status, total, paidAmount);

  return { paidAmount, dueAmount, refundOwed, paymentStatus };
}

/** Enforce status and remaining due bounds before recording a `PAYMENT` entry. */
export function assertCanRecordPayment(
  status: OrderStatus,
  dueAmount: number,
  amount: number,
): void {
  if (isOrderClosedForPayment(status)) {
    throw new OrderClosedError();
  }
  if (amount > dueAmount) {
    throw new PaymentExceedsDueError(dueAmount);
  }
}

/** Enforce net paid bound before recording a `REFUND` entry (allowed in any status). */
export function assertCanRecordRefund(paidAmount: number, amount: number): void {
  if (amount > paidAmount) {
    throw new RefundExceedsPaidError(paidAmount);
  }
}

/**
 * Enforce single void and `0 <= nextPaid <= total` across all order statuses
 * (active and closed) so voiding a refund can never violate `orders_paid_within_total`.
 */
export function assertCanVoidPayment(
  orderTotal: number,
  currentPaidAmount: number,
  target: Pick<Payment, 'kind' | 'amount' | 'voidedAt'>,
): void {
  if (target.voidedAt !== undefined) {
    throw new PaymentAlreadyVoidedError();
  }
  const nextPaid =
    target.kind === PaymentKind.PAYMENT
      ? currentPaidAmount - target.amount
      : currentPaidAmount + target.amount;
  if (nextPaid < 0 || nextPaid > orderTotal) {
    throw new VoidBreaksBalanceError(currentPaidAmount, orderTotal);
  }
}

/** Enforce that an edited order total never falls below the amount already paid. */
export function assertTotalCoversPaid(newTotal: number, paidAmount: number): void {
  if (newTotal < paidAmount) {
    throw new TotalBelowPaidError(paidAmount);
  }
}

/** True when a payment method may be recorded for a business using `currency`. */
export function isMethodAllowedForCurrency(method: PaymentMethodType, currency: string): boolean {
  return availablePaymentMethods(currency).includes(method);
}
