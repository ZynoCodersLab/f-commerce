import { z } from 'zod';

import {
  CreateOptionalDateSchema,
  EditOptionalDateSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
} from './datetime.js';
import { InitialPaymentSchema, PaymentEntrySchema, PaymentStatusSchema } from './payment.js';

/** The status path an order follows, from creation to its final state. */
export const ORDER_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
] as const;

/** The sales channel an order came from. */
export const ORDER_SOURCES = [
  'FACEBOOK',
  'WHATSAPP',
  'INSTAGRAM',
  'TIKTOK',
  'DIRECT',
  'OTHER',
] as const;

export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export const OrderSourceSchema = z.enum(ORDER_SOURCES);

export type OrderStatusType = (typeof ORDER_STATUSES)[number];
export type OrderSourceType = (typeof ORDER_SOURCES)[number];

/** Actions recorded in the audit log for order writes. */
export const OrderAuditAction = {
  CREATED: 'ORDER_CREATED',
  UPDATED: 'ORDER_UPDATED',
} as const;

/** Error codes returned by the order endpoints. */
export const OrderErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CUSTOMER_ARCHIVED: 'CUSTOMER_ARCHIVED',
  ORDER_LOCKED: 'ORDER_LOCKED',
  ORDER_CHANGED: 'ORDER_CHANGED',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  DUPLICATE_ORDER: 'DUPLICATE_ORDER',
  TOTAL_BELOW_PAID: 'TOTAL_BELOW_PAID',
} as const;

export type OrderAuditActionType = (typeof OrderAuditAction)[keyof typeof OrderAuditAction];
export type OrderErrorCodeType = (typeof OrderErrorCode)[keyof typeof OrderErrorCode];

const MAX_MONEY_INPUT = 100_000_000;
const MAX_OPTIONAL_TEXT = 500;
const MAX_STATUS_NOTE = 200;

/**
 * A defensive cap on the raw request array, not the order line limit. Lines
 * are merged by product and variant first, and the service enforces the real
 * limit of 50 distinct pairs after merging (AC-1, AC-11). A generous bound
 * here still limits the payload size without rejecting valid merged orders.
 */
const MAX_RAW_ORDER_LINES = 200;

const moneyInput = z.number().int().min(0).max(MAX_MONEY_INPUT);

/** Create treats omitted, null, and blank optional text the same way: absent. */
const createOptionalText = z
  .string()
  .trim()
  .max(MAX_OPTIONAL_TEXT)
  .nullable()
  .optional()
  .transform((value) => {
    if (value === null || value === undefined) return null;
    return value === '' ? null : value;
  });

/** Edit keeps omitted fields unchanged, while null or blank clears the field. */
const editOptionalText = z
  .string()
  .trim()
  .max(MAX_OPTIONAL_TEXT)
  .nullable()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return value === '' ? null : value;
  });

/** One line in a create request. Lines with the same pair are merged server side. */
export const OrderItemInputSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().min(1).max(1000),
  unitPrice: moneyInput.optional(),
});

/** One line in an edit request. `lineId` identifies a line that already exists. */
export const OrderItemUpdateInputSchema = OrderItemInputSchema.extend({
  lineId: z.string().uuid().optional(),
});

export const OrderCreateSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(OrderItemInputSchema).min(1).max(MAX_RAW_ORDER_LINES),
  source: OrderSourceSchema,
  deliveryFee: moneyInput.optional().default(0),
  discount: moneyInput.optional().default(0),
  shippingAddress: createOptionalText,
  notes: createOptionalText,
  deliveryDeadline: CreateOptionalDateSchema,
  confirmDuplicate: z.boolean().optional().default(false),
  initialPayment: InitialPaymentSchema.nullable().optional(),
});

export const OrderUpdateSchema = z.object({
  version: z.number().int().min(1),
  customerId: z.string().uuid().optional(),
  items: z.array(OrderItemUpdateInputSchema).min(1).max(MAX_RAW_ORDER_LINES).optional(),
  deliveryFee: moneyInput.optional(),
  discount: moneyInput.optional(),
  shippingAddress: editOptionalText,
  notes: editOptionalText,
  source: OrderSourceSchema.optional(),
  deliveryDeadline: EditOptionalDateSchema,
});

export const OrderStatusChangeSchema = z.object({
  status: OrderStatusSchema,
  version: z.number().int().min(1),
  note: z
    .string()
    .trim()
    .max(MAX_STATUS_NOTE)
    .nullable()
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) return null;
      return value === '' ? null : value;
    }),
});

export const OrderItemSchema = z.object({
  id: z.string(),
  productId: z.string(),
  variantId: z.string().nullable(),
  productName: z.string(),
  variantLabel: z.string().nullable(),
  price: z.number().int(),
  cost: z.number().int(),
  quantity: z.number().int(),
  subtotal: z.number().int(),
  position: z.number().int(),
});

export const OrderStatusHistorySchema = z.object({
  id: z.string(),
  fromStatus: OrderStatusSchema.nullable(),
  toStatus: OrderStatusSchema,
  note: z.string().nullable(),
  changedByName: z.string(),
  createdAt: IsoDateTimeSchema,
});

export const OrderSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: OrderStatusSchema,
  source: OrderSourceSchema.nullable(),
  customerId: z.string().nullable(),
  customerName: z.string(),
  customerPhone: z.string(),
  shippingAddress: z.string().nullable(),
  notes: z.string().nullable(),
  deliveryDeadline: IsoDateSchema.nullable(),
  subtotal: z.number().int(),
  deliveryFee: z.number().int(),
  discount: z.number().int(),
  total: z.number().int(),
  paidAmount: z.number().int(),
  dueAmount: z.number().int(),
  refundOwed: z.number().int(),
  paymentStatus: PaymentStatusSchema,
  version: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  items: z.array(OrderItemSchema),
  history: z.array(OrderStatusHistorySchema),
  payments: z.array(PaymentEntrySchema),
});

export const OrderSummarySchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: OrderStatusSchema,
  customerName: z.string(),
  total: z.number().int(),
  paidAmount: z.number().int(),
  dueAmount: z.number().int(),
  refundOwed: z.number().int(),
  paymentStatus: PaymentStatusSchema,
  source: OrderSourceSchema.nullable(),
  deliveryDeadline: IsoDateSchema.nullable(),
  itemCount: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const OrderPageSchema = z.object({
  items: z.array(OrderSummarySchema),
  nextCursor: z.string().nullable(),
});

/** The order that triggered a duplicate warning. */
export const DuplicateOrderExistingSchema = z.object({
  id: z.string(),
  orderNumber: z.string(),
  status: OrderStatusSchema,
  total: z.number().int(),
  createdAt: IsoDateTimeSchema,
});

export const DuplicateOrderErrorSchema = z.object({
  error: z.literal(OrderErrorCode.DUPLICATE_ORDER),
  message: z.string(),
  existingOrder: DuplicateOrderExistingSchema,
});

export type OrderItemInput = z.infer<typeof OrderItemInputSchema>;
export type OrderItemUpdateInput = z.infer<typeof OrderItemUpdateInputSchema>;
export type OrderCreateRequest = z.infer<typeof OrderCreateSchema>;
export type OrderUpdateRequest = z.infer<typeof OrderUpdateSchema>;
export type OrderStatusChangeRequest = z.infer<typeof OrderStatusChangeSchema>;
export type OrderItemDto = z.infer<typeof OrderItemSchema>;
export type OrderStatusHistoryDto = z.infer<typeof OrderStatusHistorySchema>;
export type OrderDto = z.infer<typeof OrderSchema>;
export type OrderSummaryDto = z.infer<typeof OrderSummarySchema>;
export type OrderPageDto = z.infer<typeof OrderPageSchema>;
export type DuplicateOrderExisting = z.infer<typeof DuplicateOrderExistingSchema>;
export type DuplicateOrderError = z.infer<typeof DuplicateOrderErrorSchema>;
