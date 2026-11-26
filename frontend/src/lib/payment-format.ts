import {
  MAX_PAYMENT_AMOUNT,
  TRANSACTION_ID_PAYMENT_METHODS,
  type OrderStatusType,
  type PaymentKindType,
  type PaymentMethodType,
  type PaymentStatusType,
} from '@f-commerce/contracts';

export const PAYMENT_METHOD_LABEL: Record<PaymentMethodType, string> = {
  CASH: 'Cash',
  CASH_ON_DELIVERY: 'Cash on delivery',
  BKASH: 'bKash',
  NAGAD: 'Nagad',
  BANK_TRANSFER: 'Bank transfer',
  CARD: 'Debit or credit card',
  PAYPAL: 'PayPal',
  OTHER: 'Other',
};

export const PAYMENT_KIND_LABEL: Record<PaymentKindType, string> = {
  PAYMENT: 'Payment',
  REFUND: 'Refund',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatusType, string> = {
  UNPAID: 'Unpaid',
  PARTIAL: 'Partial',
  PAID: 'Paid',
  REFUND_OWED: 'Refund owed',
  NONE: 'No payments',
};

/** Semantic token classes for payment status pills across light and dark themes. */
export const PAYMENT_STATUS_TONE: Record<PaymentStatusType, string> = {
  UNPAID: 'bg-warning-soft text-warning',
  PARTIAL: 'bg-sky-soft text-sky-strong',
  PAID: 'bg-success-soft text-success',
  REFUND_OWED: 'bg-danger-soft text-danger',
  NONE: 'bg-surface-muted text-muted',
};

export function paymentReferenceLabel(method: PaymentMethodType): string {
  return (TRANSACTION_ID_PAYMENT_METHODS as readonly string[]).includes(method)
    ? 'Transaction ID (optional)'
    : 'Reference (optional)';
}

export function isCardMethod(method: PaymentMethodType): boolean {
  return method === 'CARD';
}

export function isOrderClosedForPayment(status: OrderStatusType): boolean {
  return status === 'CANCELLED' || status === 'RETURNED';
}

/** Parse a positive whole unit payment amount, or null when invalid. */
export function parsePaymentAmountInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAYMENT_AMOUNT) return null;
  return parsed;
}
