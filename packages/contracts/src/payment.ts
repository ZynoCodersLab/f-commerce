import { z } from 'zod';

import { CreateOptionalDateSchema, IsoDateSchema, IsoDateTimeSchema } from './datetime.js';

/** Every payment method the ledger supports. Matches the backend PaymentMethod enum. */
export const PAYMENT_METHODS = [
  'CASH',
  'CASH_ON_DELIVERY',
  'BKASH',
  'NAGAD',
  'BANK_TRANSFER',
  'CARD',
  'PAYPAL',
  'OTHER',
] as const;

/** Methods restricted to businesses operating in Bangladeshi Taka (BDT). */
export const BD_ONLY_PAYMENT_METHODS = ['BKASH', 'NAGAD'] as const;

/** Methods whose reference field is labelled Transaction ID in the UI. */
export const TRANSACTION_ID_PAYMENT_METHODS = [
  'BKASH',
  'NAGAD',
  'BANK_TRANSFER',
  'CARD',
  'PAYPAL',
] as const;

/** Ledger entry kinds. Positive amounts only; kind sets the sign in the balance. */
export const PAYMENT_KINDS = ['PAYMENT', 'REFUND'] as const;

/** Derived payment status of an order (never stored in the database). */
export const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID', 'REFUND_OWED', 'NONE'] as const;

/** Allowed filter values for `GET /api/orders?paymentStatus=...` (`NONE` is rejected). */
export const PAYMENT_STATUS_FILTER_VALUES = ['UNPAID', 'PARTIAL', 'PAID', 'REFUND_OWED'] as const;

export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export const PaymentKindSchema = z.enum(PAYMENT_KINDS);
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export const PaymentStatusFilterSchema = z.enum(PAYMENT_STATUS_FILTER_VALUES);

export type PaymentMethodType = (typeof PAYMENT_METHODS)[number];
export type PaymentKindType = (typeof PAYMENT_KINDS)[number];
export type PaymentStatusType = (typeof PAYMENT_STATUSES)[number];
export type PaymentStatusFilterType = (typeof PAYMENT_STATUS_FILTER_VALUES)[number];

/** Return the payment methods allowed for new entries in a business currency. */
export function availablePaymentMethods(currency: string): readonly PaymentMethodType[] {
  if (currency === 'BDT') return PAYMENT_METHODS;
  return PAYMENT_METHODS.filter(
    (method) => !(BD_ONLY_PAYMENT_METHODS as readonly string[]).includes(method),
  );
}

/** Actions recorded in the audit log for payment mutations. */
export const PaymentAuditAction = {
  RECORDED: 'PAYMENT_RECORDED',
  REFUND_RECORDED: 'REFUND_RECORDED',
  VOIDED: 'PAYMENT_VOIDED',
} as const;

/** Error codes returned by the payment endpoints and payment guards on order writes. */
export const PaymentErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  ORDER_CLOSED: 'ORDER_CLOSED',
  PAYMENT_EXCEEDS_DUE: 'PAYMENT_EXCEEDS_DUE',
  REFUND_EXCEEDS_PAID: 'REFUND_EXCEEDS_PAID',
  PAYMENT_ALREADY_VOIDED: 'PAYMENT_ALREADY_VOIDED',
  VOID_BREAKS_BALANCE: 'VOID_BREAKS_BALANCE',
  TOTAL_BELOW_PAID: 'TOTAL_BELOW_PAID',
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
} as const;

export type PaymentAuditActionType = (typeof PaymentAuditAction)[keyof typeof PaymentAuditAction];
export type PaymentErrorCodeType = (typeof PaymentErrorCode)[keyof typeof PaymentErrorCode];

export const MAX_PAYMENT_AMOUNT = 100_000_000;
const MAX_PAYMENT_REFERENCE = 100;
const MAX_PAYMENT_NOTES = 500;
const MAX_VOID_REASON = 200;

function optionalTrimmedText(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .nullable()
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) return null;
      return value === '' ? null : value;
    });
}

/** Request payload for `POST /api/orders/:id/payments` and `POST /api/orders/:id/refunds`. */
export const PaymentCreateSchema = z.object({
  amount: z.number().int().min(1).max(MAX_PAYMENT_AMOUNT),
  method: PaymentMethodSchema,
  paymentDate: CreateOptionalDateSchema,
  referenceNumber: optionalTrimmedText(MAX_PAYMENT_REFERENCE),
  notes: optionalTrimmedText(MAX_PAYMENT_NOTES),
});

/** Optional first payment captured alongside order creation. */
export const InitialPaymentSchema = PaymentCreateSchema;

/** Request payload for `POST /api/orders/:id/payments/:paymentId/void`. */
export const PaymentVoidSchema = z.object({
  reason: z.string().trim().min(1, 'Reason is required').max(MAX_VOID_REASON),
});

/** One payment or refund entry returned on an order detail. */
export const PaymentEntrySchema = z.object({
  id: z.string(),
  kind: PaymentKindSchema,
  amount: z.number().int(),
  method: PaymentMethodSchema,
  referenceNumber: z.string().nullable(),
  notes: z.string().nullable(),
  paymentDate: IsoDateSchema,
  recordedByName: z.string(),
  createdAt: IsoDateTimeSchema,
  voidedAt: IsoDateTimeSchema.nullable(),
  voidedByName: z.string().nullable(),
  voidReason: z.string().nullable(),
});

/** One entry in the business wide `/api/payments` ledger response. */
export const PaymentLedgerItemSchema = PaymentEntrySchema.extend({
  orderId: z.string(),
  orderNumber: z.string(),
  customerName: z.string(),
});

/** Totals for the whole filtered ledger range (excluding voided entries). */
export const PaymentLedgerSummarySchema = z.object({
  collected: z.number().int(),
  refunded: z.number().int(),
  net: z.number().int(),
});

/** Query parameters accepted by `GET /api/payments`. */
export const PaymentLedgerQuerySchema = z.object({
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  method: z.string().optional(),
  kind: PaymentKindSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Paginated response for `GET /api/payments`. */
export const PaymentLedgerPageSchema = z.object({
  items: z.array(PaymentLedgerItemSchema),
  summary: PaymentLedgerSummarySchema,
  nextCursor: z.string().nullable(),
});

export type PaymentCreateRequest = z.infer<typeof PaymentCreateSchema>;
export type InitialPaymentRequest = z.infer<typeof InitialPaymentSchema>;
export type PaymentVoidRequest = z.infer<typeof PaymentVoidSchema>;
export type PaymentEntryDto = z.infer<typeof PaymentEntrySchema>;
export type PaymentLedgerItemDto = z.infer<typeof PaymentLedgerItemSchema>;
export type PaymentLedgerSummaryDto = z.infer<typeof PaymentLedgerSummarySchema>;
export type PaymentLedgerQuery = z.infer<typeof PaymentLedgerQuerySchema>;
export type PaymentLedgerPageDto = z.infer<typeof PaymentLedgerPageSchema>;
