import { TenantEntity } from './base.entity.js';

export enum OrderStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  PROCESSING = 'PROCESSING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  RETURNED = 'RETURNED',
}

/** Statuses an order can still be edited in. */
export const EDITABLE_ORDER_STATUSES: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.CONFIRMED];

/**
 * The status where stock leaves the shelf. Stock is taken once, on arrival
 * here, and restored once, when a confirmed order is cancelled or returned, so
 * a round trip always nets zero.
 */
export const STOCK_RESERVED_STATUS: OrderStatus = OrderStatus.CONFIRMED;

/** The statuses that put back what CONFIRMED took. */
export const STOCK_RELEASING_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
];

/**
 * Statuses an order occupies after its sale has taken stock. A return is only
 * reachable from SHIPPED or DELIVERED, never straight from CONFIRMED, so the
 * restore has to fire from every status on this path.
 */
export const STOCK_HELD_STATUSES: OrderStatus[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/**
 * Which way a single status change moves stock, or null when it moves none.
 * Sale: the order is being confirmed. Restoration: an order whose sale already
 * took stock is being cancelled or returned, which includes the normal
 * CONFIRMED -> PROCESSING -> SHIPPED -> RETURNED path. A return that never
 * sold anything, such as PENDING -> CANCELLED, has nothing to restore.
 */
export function getStockMovement(
  from: OrderStatus,
  to: OrderStatus,
): 'sale' | 'restoration' | null {
  if (to === STOCK_RESERVED_STATUS && from !== STOCK_RESERVED_STATUS) return 'sale';
  if (STOCK_HELD_STATUSES.includes(from) && STOCK_RELEASING_STATUSES.includes(to)) {
    return 'restoration';
  }
  return null;
}

/** The only status moves the workflow allows. */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.RETURNED],
  [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};

export interface Order extends TenantEntity {
  customerId: string | null;
  orderNumber: string; // Human-readable order identifier
  status: OrderStatus;
  customerNameSnapshot: string;
  customerPhoneSnapshot: string;
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number; // subtotal + deliveryFee - discount
  paidAmount: number;
  dueAmount: number; // total - paidAmount
  shippingAddress?: string;
  courierId?: string;
  trackingNumber?: string;
  source?: string; // one of the contract channel values
  notes?: string;
  deliveryDeadline?: string; // YYYY-MM-DD, the promised delivery date
  idempotencyKey?: string;
  version: number;
}

export interface OrderItem extends TenantEntity {
  orderId: string;
  productId: string;
  variantId?: string;
  productNameSnapshot: string; // Snapshot of name at time of order
  variantLabelSnapshot?: string; // Snapshot of the variant label at time of order
  priceSnapshot: number; // Snapshot of price at time of order
  costSnapshot: number; // Snapshot of cost at time of order
  quantity: number;
  subtotal: number; // quantity * priceSnapshot
  position: number;
}

/** One append only row of the order's status timeline. */
export interface OrderStatusHistory {
  id: string;
  businessId: string;
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  note?: string;
  changedByUserId: string;
  changedByName: string;
  createdAt: Date;
}

export interface OrderDetail {
  order: Order;
  items: OrderItem[];
  history: OrderStatusHistory[];
}

/** A list row without the full item and history payload. */
export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  customerNameSnapshot: string;
  total: number;
  dueAmount: number;
  source?: string;
  deliveryDeadline?: string; // YYYY-MM-DD, the promised delivery date
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}
