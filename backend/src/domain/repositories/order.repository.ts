import { Customer } from '../entities/customer.entity.js';
import { OrderDetail, OrderStatus, OrderSummary } from '../entities/order.entity.js';

/** The product fields an order line needs when the catalog is resolved. */
export interface OrderCatalogProduct {
  id: string;
  name: string;
  price: number;
  cost: number | null;
  isArchived: boolean;
  options: { name: string; values: string[] }[];
}

/** The variant fields an order line needs when the catalog is resolved. */
export interface OrderCatalogVariant {
  id: string;
  productId: string;
  price: number | null;
  cost: number | null;
  combination: Record<string, string>;
}

/** The product and variant pair that identifies one merged order line. */
export interface OrderPair {
  productId: string;
  variantId: string | null;
}

export interface OrderCreateData {
  customerId: string;
  customerNameSnapshot: string;
  customerPhoneSnapshot: string;
  source: string;
  deliveryFee: number;
  discount: number;
  subtotal: number;
  total: number;
  dueAmount: number;
  shippingAddress: string | null;
  notes: string | null;
  deliveryDeadline: string | null;
  idempotencyKey: string | null;
}

/** A fully resolved line, ready to be written. `id` marks an existing line. */
export interface OrderWriteItem {
  id?: string;
  productId: string;
  variantId: string | null;
  productNameSnapshot: string;
  variantLabelSnapshot: string | null;
  priceSnapshot: number;
  costSnapshot: number;
  quantity: number;
  subtotal: number;
  position: number;
}

export interface OrderUpdateData {
  customerId?: string;
  customerNameSnapshot?: string;
  customerPhoneSnapshot?: string;
  source?: string;
  deliveryFee?: number;
  discount?: number;
  subtotal?: number;
  total?: number;
  dueAmount?: number;
  shippingAddress?: string | null;
  notes?: string | null;
  deliveryDeadline?: string | null;
}

export interface OrderAuditEntry {
  businessId: string;
  userId: string;
  action: string;
  metadata?: string;
}

export interface OrderListQuery {
  statuses: OrderStatus[];
  /** Trimmed search text, matched as a contains across the allowed fields. */
  q: string;
  /** The digits of the search text, matched against the phone snapshot. */
  phoneDigits: string;
  limit: number;
  createdAt?: Date;
  id?: string;
}

export interface OrderListResult {
  items: OrderSummary[];
  hasMore: boolean;
}

export interface OrderHistoryWrite {
  changedByUserId: string;
  changedByName: string;
  note: string | null;
  /** The status the order moved from; null on the creation row. */
  fromStatus?: OrderStatus | null;
}

/**
 * One line's stock movement, applied in the same transaction as the status
 * change. A sale takes stock for a newly confirmed order; a restoration puts
 * the same units back when a confirmed order is cancelled or returned.
 */
export interface OrderStockMove {
  kind: 'sale' | 'restoration';
  productId: string;
  variantId: string | null;
  quantity: number;
}

export interface IOrderRepository {
  findDetailById(id: string): Promise<OrderDetail | null>;
  findDetailByIdempotencyKey(key: string): Promise<OrderDetail | null>;
  list(query: OrderListQuery): Promise<OrderListResult>;
  /** The most recent order within 24 hours with the same customer and item set. */
  findDuplicate(customerId: string, pairs: OrderPair[]): Promise<OrderSummary | null>;
  findCustomer(customerId: string): Promise<Customer | null>;
  findCatalogProducts(ids: string[]): Promise<OrderCatalogProduct[]>;
  findCatalogVariants(ids: string[]): Promise<OrderCatalogVariant[]>;
  findActorName(userId: string): Promise<string | null>;
  create(
    data: OrderCreateData,
    items: OrderWriteItem[],
    history: OrderHistoryWrite,
    audit: OrderAuditEntry,
  ): Promise<OrderDetail>;
  update(
    id: string,
    expectedVersion: number,
    changes: OrderUpdateData,
    items: OrderWriteItem[] | null,
    audit: OrderAuditEntry,
  ): Promise<OrderDetail | null>;
  changeStatus(
    id: string,
    expectedVersion: number,
    status: OrderStatus,
    history: OrderHistoryWrite,
    stockMoves?: OrderStockMove[],
  ): Promise<OrderDetail | null>;
}
