import {
  ORDER_SOURCES,
  OrderDto,
  OrderSourceType,
  OrderSummaryDto,
  PaymentEntryDto,
  PaymentLedgerItemDto,
} from '@f-commerce/contracts';
import { Payment, PaymentLedgerItem } from '../../domain/entities/financial.entity.js';
import { OrderDetail, OrderItem, OrderSummary } from '../../domain/entities/order.entity.js';
import { derivePaymentStatus, deriveRefundOwed } from '../../domain/order-payments.js';

function toSource(value: string | undefined): OrderSourceType | null {
  return value !== undefined && (ORDER_SOURCES as readonly string[]).includes(value)
    ? (value as OrderSourceType)
    : null;
}

function toItemDto(item: OrderItem) {
  return {
    id: item.id,
    productId: item.productId,
    variantId: item.variantId ?? null,
    productName: item.productNameSnapshot,
    variantLabel: item.variantLabelSnapshot ?? null,
    price: item.priceSnapshot,
    cost: item.costSnapshot,
    quantity: item.quantity,
    subtotal: item.subtotal,
    position: item.position,
  };
}

export function toPaymentDto(payment: Payment): PaymentEntryDto {
  return {
    id: payment.id,
    kind: payment.kind,
    amount: payment.amount,
    method: payment.method,
    referenceNumber: payment.referenceNumber ?? null,
    notes: payment.notes ?? null,
    paymentDate: payment.paymentDate,
    recordedByName: payment.recordedByName,
    createdAt: payment.createdAt.toISOString(),
    voidedAt: payment.voidedAt ? payment.voidedAt.toISOString() : null,
    voidedByName: payment.voidedByName ?? null,
    voidReason: payment.voidReason ?? null,
  };
}

export function toPaymentLedgerItemDto(item: PaymentLedgerItem): PaymentLedgerItemDto {
  return {
    ...toPaymentDto(item),
    orderId: item.orderId,
    orderNumber: item.orderNumber,
    customerName: item.customerNameSnapshot,
  };
}

export function toOrderDto(detail: OrderDetail): OrderDto {
  const order = detail.order;
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    source: toSource(order.source),
    customerId: order.customerId,
    customerName: order.customerNameSnapshot,
    customerPhone: order.customerPhoneSnapshot,
    shippingAddress: order.shippingAddress ?? null,
    notes: order.notes ?? null,
    deliveryDeadline: order.deliveryDeadline ?? null,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    discount: order.discount,
    total: order.total,
    paidAmount: order.paidAmount,
    dueAmount: order.dueAmount,
    refundOwed: deriveRefundOwed(order.status, order.paidAmount),
    paymentStatus: derivePaymentStatus(order.status, order.total, order.paidAmount),
    version: order.version,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: detail.items.map(toItemDto),
    history: detail.history.map((row) => ({
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      note: row.note ?? null,
      changedByName: row.changedByName,
      createdAt: row.createdAt.toISOString(),
    })),
    payments: detail.payments.map(toPaymentDto),
  };
}

export function toOrderSummaryDto(summary: OrderSummary): OrderSummaryDto {
  return {
    id: summary.id,
    orderNumber: summary.orderNumber,
    status: summary.status,
    customerName: summary.customerNameSnapshot,
    total: summary.total,
    paidAmount: summary.paidAmount,
    dueAmount: summary.dueAmount,
    refundOwed: deriveRefundOwed(summary.status, summary.paidAmount),
    paymentStatus: derivePaymentStatus(summary.status, summary.total, summary.paidAmount),
    source: toSource(summary.source),
    deliveryDeadline: summary.deliveryDeadline ?? null,
    itemCount: summary.itemCount,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  };
}
