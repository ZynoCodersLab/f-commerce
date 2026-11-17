import { and, asc, desc, eq, gte, inArray, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getDb } from '../client.js';
import { getTenantId } from '../context.js';
import {
  auditLogs,
  businessOrderCounters,
  customers,
  inventoryTransactions,
  orderItems,
  orders,
  orderStatusHistory,
  productVariants,
  products,
  users,
} from '../schema.js';
import { isUuid } from '../../../../domain/uuid.js';
import { Customer } from '../../../../domain/entities/customer.entity.js';
import { InventoryTransactionType } from '../../../../domain/entities/inventory.entity.js';
import {
  Order,
  OrderDetail,
  OrderItem,
  OrderStatus,
  OrderStatusHistory,
  OrderSummary,
} from '../../../../domain/entities/order.entity.js';
import {
  IOrderRepository,
  OrderAuditEntry,
  OrderCatalogProduct,
  OrderCatalogVariant,
  OrderCreateData,
  OrderHistoryWrite,
  OrderListQuery,
  OrderListResult,
  OrderPair,
  OrderStockMove,
  OrderUpdateData,
  OrderWriteItem,
} from '../../../../domain/repositories/order.repository.js';

type DbTransaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/** Escape LIKE metacharacters so search treats them literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** `ORD-` followed by at least four digits. */
export function formatOrderNumber(value: number): string {
  return `ORD-${String(value).padStart(4, '0')}`;
}

function pairKey(pair: OrderPair): string {
  return `${pair.productId}:${pair.variantId ?? ''}`;
}

function toOrder(row: typeof orders.$inferSelect): Order {
  return {
    id: row.id,
    customerId: row.customerId,
    orderNumber: row.orderNumber,
    status: row.status,
    customerNameSnapshot: row.customerNameSnapshot,
    customerPhoneSnapshot: row.customerPhoneSnapshot,
    subtotal: row.subtotal,
    deliveryFee: row.deliveryFee,
    discount: row.discount,
    total: row.total,
    paidAmount: row.paidAmount,
    dueAmount: row.dueAmount,
    shippingAddress: row.shippingAddress ?? undefined,
    courierId: row.courierId ?? undefined,
    trackingNumber: row.trackingNumber ?? undefined,
    source: row.source ?? undefined,
    notes: row.notes ?? undefined,
    deliveryDeadline: row.deliveryDeadline ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    version: row.version,
    businessId: row.businessId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toItem(row: typeof orderItems.$inferSelect): OrderItem {
  return {
    id: row.id,
    orderId: row.orderId,
    productId: row.productId,
    variantId: row.variantId ?? undefined,
    productNameSnapshot: row.productNameSnapshot,
    variantLabelSnapshot: row.variantLabelSnapshot ?? undefined,
    priceSnapshot: row.priceSnapshot,
    costSnapshot: row.costSnapshot,
    quantity: row.quantity,
    subtotal: row.subtotal,
    position: row.position,
    businessId: row.businessId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toHistory(row: typeof orderStatusHistory.$inferSelect): OrderStatusHistory {
  return {
    id: row.id,
    businessId: row.businessId,
    orderId: row.orderId,
    fromStatus: row.fromStatus ?? null,
    toStatus: row.toStatus,
    note: row.note ?? undefined,
    changedByUserId: row.changedByUserId,
    changedByName: row.changedByName,
    createdAt: row.createdAt,
  };
}

function toSummary(row: {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  customerNameSnapshot: string;
  total: number;
  dueAmount: number;
  source: string | null;
  deliveryDeadline: string | null;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}): OrderSummary {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    customerNameSnapshot: row.customerNameSnapshot,
    total: row.total,
    dueAmount: row.dueAmount,
    source: row.source ?? undefined,
    deliveryDeadline: row.deliveryDeadline ?? undefined,
    itemCount: Number(row.itemCount),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function itemValues(
  businessId: string,
  orderId: string,
  items: OrderWriteItem[],
): (typeof orderItems.$inferInsert)[] {
  return items.map((item) => ({
    businessId,
    orderId,
    productId: item.productId,
    variantId: item.variantId,
    productNameSnapshot: item.productNameSnapshot,
    variantLabelSnapshot: item.variantLabelSnapshot,
    priceSnapshot: item.priceSnapshot,
    costSnapshot: item.costSnapshot,
    quantity: item.quantity,
    subtotal: item.subtotal,
    position: item.position,
  }));
}

const ORDER_ITEM_COUNT = sql<number>`(
  select count(*)::int from ${orderItems}
  where ${orderItems.orderId} = ${sql.raw('"orders"."id"')}
)`;

export class DrizzleOrderRepository implements IOrderRepository {
  async findDetailById(id: string): Promise<OrderDetail | null> {
    const businessId = getTenantId();
    if (!businessId || !isUuid(id)) return null;

    const orderRows = await getDb()
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.businessId, businessId)));
    if (orderRows.length === 0) return null;

    return this.readDetail(orderRows[0]);
  }

  async findDetailByIdempotencyKey(key: string): Promise<OrderDetail | null> {
    const businessId = getTenantId();
    if (!businessId) return null;

    const rows = await getDb()
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.idempotencyKey, key),
          sql`${orders.idempotencyKey} IS NOT NULL`,
        ),
      );
    if (rows.length === 0) return null;
    return this.findDetailById(rows[0].id);
  }

  async list(query: OrderListQuery): Promise<OrderListResult> {
    const businessId = getTenantId();
    if (!businessId) return { items: [], hasMore: false };

    const conditions: SQL[] = [eq(orders.businessId, businessId)];

    if (query.statuses.length > 0) {
      conditions.push(inArray(orders.status, query.statuses));
    }

    if (query.q !== '') {
      const pattern = `%${escapeLike(query.q)}%`;
      const searchConditions: SQL[] = [
        sql`${orders.orderNumber} ILIKE ${pattern}`,
        sql`${orders.customerNameSnapshot} ILIKE ${pattern}`,
      ];
      if (query.phoneDigits !== '') {
        searchConditions.push(
          sql`regexp_replace(${orders.customerPhoneSnapshot}, '[^0-9]', '', 'g') LIKE ${`%${query.phoneDigits}%`}`,
        );
      }
      const combined = or(...searchConditions);
      if (combined) conditions.push(combined);
    }

    if (query.createdAt !== undefined && query.id !== undefined && isUuid(query.id)) {
      const cursorCondition = or(
        lt(orders.createdAt, query.createdAt),
        and(eq(orders.createdAt, query.createdAt), lt(orders.id, query.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }

    const rows = await getDb()
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        customerNameSnapshot: orders.customerNameSnapshot,
        total: orders.total,
        dueAmount: orders.dueAmount,
        source: orders.source,
        deliveryDeadline: orders.deliveryDeadline,
        itemCount: ORDER_ITEM_COUNT,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
      })
      .from(orders)
      .where(and(...conditions))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const items = (hasMore ? rows.slice(0, query.limit) : rows).map(toSummary);
    return { items, hasMore };
  }

  async findDuplicate(customerId: string, pairs: OrderPair[]): Promise<OrderSummary | null> {
    const businessId = getTenantId();
    if (!businessId || !isUuid(customerId) || pairs.length === 0) return null;

    const rows = await getDb()
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        customerNameSnapshot: orders.customerNameSnapshot,
        total: orders.total,
        dueAmount: orders.dueAmount,
        source: orders.source,
        deliveryDeadline: orders.deliveryDeadline,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
        pairs: sql<string[]>`(
          select coalesce(array_agg(distinct concat(${orderItems.productId}::text, ':', coalesce(${orderItems.variantId}::text, ''))), '{}'::text[])
          from ${orderItems}
          where ${orderItems.orderId} = ${sql.raw('"orders"."id"')}
        )`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.businessId, businessId),
          eq(orders.customerId, customerId),
          ne(orders.status, OrderStatus.CANCELLED),
          gte(orders.createdAt, sql`now() - interval '24 hours'`),
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(100); // Performance safeguard: limits to 100 most recent orders when a customer has many orders in 24h

    const wanted = new Set(pairs.map(pairKey));
    for (const row of rows) {
      const stored = new Set(row.pairs ?? []);
      if (stored.size !== wanted.size) continue;
      let matches = true;
      for (const key of wanted) {
        if (!stored.has(key)) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return toSummary({ ...row, itemCount: stored.size });
      }
    }
    return null;
  }

  async findCustomer(customerId: string): Promise<Customer | null> {
    const businessId = getTenantId();
    if (!businessId || !isUuid(customerId)) return null;

    const rows = await getDb()
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)));
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email ?? undefined,
      address: row.address ?? undefined,
      notes: row.notes ?? undefined,
      archivedAt: row.archivedAt ?? undefined,
      version: row.version,
      businessId: row.businessId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async findCatalogProducts(ids: string[]): Promise<OrderCatalogProduct[]> {
    const businessId = getTenantId();
    const valid = [...new Set(ids.filter((id) => isUuid(id)))];
    if (!businessId || valid.length === 0) return [];

    return await getDb()
      .select({
        id: products.id,
        name: products.name,
        price: products.price,
        cost: products.cost,
        isArchived: products.isArchived,
        options: products.options,
      })
      .from(products)
      .where(and(eq(products.businessId, businessId), inArray(products.id, valid)));
  }

  async findCatalogVariants(ids: string[]): Promise<OrderCatalogVariant[]> {
    const businessId = getTenantId();
    const valid = [...new Set(ids.filter((id) => isUuid(id)))];
    if (!businessId || valid.length === 0) return [];

    return await getDb()
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        price: productVariants.price,
        cost: productVariants.cost,
        combination: productVariants.combination,
      })
      .from(productVariants)
      .where(and(eq(productVariants.businessId, businessId), inArray(productVariants.id, valid)));
  }

  async findActorName(userId: string): Promise<string | null> {
    if (!isUuid(userId)) return null;
    const rows = await getDb().select({ name: users.name }).from(users).where(eq(users.id, userId));
    return rows.length === 0 ? null : rows[0].name;
  }

  async create(
    data: OrderCreateData,
    items: OrderWriteItem[],
    history: OrderHistoryWrite,
    audit: OrderAuditEntry,
  ): Promise<OrderDetail> {
    const businessId = getTenantId();
    if (!businessId) throw new Error('No business context');

    return await getDb().transaction(async (tx) => {
      const now = new Date();
      const counter = await tx
        .insert(businessOrderCounters)
        .values({ businessId, lastNumber: 1, updatedAt: now })
        .onConflictDoUpdate({
          target: businessOrderCounters.businessId,
          set: {
            lastNumber: sql`${businessOrderCounters.lastNumber} + 1`,
            updatedAt: now,
          },
        })
        .returning({ lastNumber: businessOrderCounters.lastNumber });

      const orderNumber = formatOrderNumber(counter[0].lastNumber);

      const orderRows = await tx
        .insert(orders)
        .values({
          businessId,
          customerId: data.customerId,
          orderNumber,
          status: OrderStatus.PENDING,
          customerNameSnapshot: data.customerNameSnapshot,
          customerPhoneSnapshot: data.customerPhoneSnapshot,
          subtotal: data.subtotal,
          deliveryFee: data.deliveryFee,
          discount: data.discount,
          total: data.total,
          paidAmount: 0,
          dueAmount: data.dueAmount,
          shippingAddress: data.shippingAddress,
          source: data.source,
          notes: data.notes,
          deliveryDeadline: data.deliveryDeadline,
          idempotencyKey: data.idempotencyKey,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const order = toOrder(orderRows[0]);

      const insertedItems = await tx
        .insert(orderItems)
        .values(itemValues(businessId, order.id, items))
        .returning();

      const historyRows = await tx
        .insert(orderStatusHistory)
        .values({
          businessId,
          orderId: order.id,
          fromStatus: null,
          toStatus: OrderStatus.PENDING,
          note: history.note,
          changedByUserId: history.changedByUserId,
          changedByName: history.changedByName,
          createdAt: now,
        })
        .returning();

      await tx.insert(auditLogs).values({
        businessId,
        userId: audit.userId,
        action: audit.action,
        entityType: 'ORDER',
        entityId: order.id,
        metadata: JSON.stringify({ orderNumber: order.orderNumber, total: order.total }),
      });

      return {
        order,
        items: insertedItems.map(toItem),
        history: [toHistory(historyRows[0])],
      };
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    changes: OrderUpdateData,
    items: OrderWriteItem[] | null,
    audit: OrderAuditEntry,
  ): Promise<OrderDetail | null> {
    const businessId = getTenantId();
    if (!businessId || !isUuid(id)) return null;

    return await getDb().transaction(async (tx) => {
      const now = new Date();
      const setValues: Partial<typeof orders.$inferInsert> = {
        ...changes,
        version: expectedVersion + 1,
        updatedAt: now,
      };

      const updated = await tx
        .update(orders)
        .set(setValues)
        .where(
          and(
            eq(orders.id, id),
            eq(orders.businessId, businessId),
            eq(orders.version, expectedVersion),
          ),
        )
        .returning();

      if (updated.length === 0) return null;

      let itemRows: (typeof orderItems.$inferSelect)[] = [];
      if (items !== null) {
        const keptIds = items
          .map((item) => item.id)
          .filter((lineId): lineId is string => lineId !== undefined);

        if (keptIds.length === 0) {
          await tx
            .delete(orderItems)
            .where(and(eq(orderItems.orderId, id), eq(orderItems.businessId, businessId)));
        } else {
          await tx
            .delete(orderItems)
            .where(
              and(
                eq(orderItems.orderId, id),
                eq(orderItems.businessId, businessId),
                notInArray(orderItems.id, keptIds),
              ),
            );
        }

        for (const item of items) {
          if (item.id !== undefined) {
            await tx
              .update(orderItems)
              .set({
                variantId: item.variantId,
                productNameSnapshot: item.productNameSnapshot,
                variantLabelSnapshot: item.variantLabelSnapshot,
                priceSnapshot: item.priceSnapshot,
                costSnapshot: item.costSnapshot,
                quantity: item.quantity,
                subtotal: item.subtotal,
                position: item.position,
                updatedAt: now,
              })
              .where(
                and(
                  eq(orderItems.id, item.id),
                  eq(orderItems.orderId, id),
                  eq(orderItems.businessId, businessId),
                ),
              );
          }
        }

        const newItems = items.filter((item) => item.id === undefined);
        if (newItems.length > 0) {
          await tx.insert(orderItems).values(itemValues(businessId, id, newItems));
        }

        itemRows = await tx
          .select()
          .from(orderItems)
          .where(and(eq(orderItems.orderId, id), eq(orderItems.businessId, businessId)))
          .orderBy(asc(orderItems.position), asc(orderItems.createdAt), asc(orderItems.id));
      } else {
        itemRows = await tx
          .select()
          .from(orderItems)
          .where(and(eq(orderItems.orderId, id), eq(orderItems.businessId, businessId)))
          .orderBy(asc(orderItems.position), asc(orderItems.createdAt), asc(orderItems.id));
      }

      await tx.insert(auditLogs).values({
        businessId,
        userId: audit.userId,
        action: audit.action,
        entityType: 'ORDER',
        entityId: id,
        metadata: audit.metadata ?? null,
      });

      const historyRows = await tx
        .select()
        .from(orderStatusHistory)
        .where(
          and(eq(orderStatusHistory.orderId, id), eq(orderStatusHistory.businessId, businessId)),
        )
        .orderBy(asc(orderStatusHistory.createdAt), asc(orderStatusHistory.id));

      return {
        order: toOrder(updated[0]),
        items: itemRows.map(toItem),
        history: historyRows.map(toHistory),
      };
    });
  }

  async changeStatus(
    id: string,
    expectedVersion: number,
    status: OrderStatus,
    history: OrderHistoryWrite,
    stockMoves: OrderStockMove[] = [],
  ): Promise<OrderDetail | null> {
    const businessId = getTenantId();
    if (!businessId || !isUuid(id)) return null;

    return await getDb().transaction(async (tx) => {
      const now = new Date();
      const updated = await tx
        .update(orders)
        .set({ status, version: expectedVersion + 1, updatedAt: now })
        .where(
          and(
            eq(orders.id, id),
            eq(orders.businessId, businessId),
            eq(orders.version, expectedVersion),
          ),
        )
        .returning();

      if (updated.length === 0) return null;

      await tx.insert(orderStatusHistory).values({
        businessId,
        orderId: id,
        fromStatus: history.fromStatus ?? null,
        toStatus: status,
        note: history.note,
        changedByUserId: history.changedByUserId,
        changedByName: history.changedByName,
        createdAt: now,
      });

      if (stockMoves.length > 0) {
        await this.applyStockMoves(tx, businessId, id, stockMoves);
      }

      const itemRows = await tx
        .select()
        .from(orderItems)
        .where(and(eq(orderItems.orderId, id), eq(orderItems.businessId, businessId)))
        .orderBy(asc(orderItems.position), asc(orderItems.createdAt), asc(orderItems.id));

      const historyRows = await tx
        .select()
        .from(orderStatusHistory)
        .where(
          and(eq(orderStatusHistory.orderId, id), eq(orderStatusHistory.businessId, businessId)),
        )
        .orderBy(asc(orderStatusHistory.createdAt), asc(orderStatusHistory.id));

      return {
        order: toOrder(updated[0]),
        items: itemRows.map(toItem),
        history: historyRows.map(toHistory),
      };
    });
  }

  private async readDetail(row: typeof orders.$inferSelect): Promise<OrderDetail> {
    const businessId = row.businessId;
    const [itemRows, historyRows] = await Promise.all([
      getDb()
        .select()
        .from(orderItems)
        .where(and(eq(orderItems.orderId, row.id), eq(orderItems.businessId, businessId)))
        .orderBy(asc(orderItems.position), asc(orderItems.createdAt), asc(orderItems.id)),
      getDb()
        .select()
        .from(orderStatusHistory)
        .where(
          and(
            eq(orderStatusHistory.orderId, row.id),
            eq(orderStatusHistory.businessId, businessId),
          ),
        )
        .orderBy(asc(orderStatusHistory.createdAt), asc(orderStatusHistory.id)),
    ]);

    return {
      order: toOrder(row),
      items: itemRows.map(toItem),
      history: historyRows.map(toHistory),
    };
  }

  /**
   * Move stock for every line of a confirmed order inside the status
   * transaction. A sale decrements the stocked level; a restoration credits
   * the same level back by the same amount, so a round trip always nets zero.
   * Lines on a product without variants adjust the product, and variant lines
   * adjust the variant and its product, so the total the UI shows stays right.
   */
  private async applyStockMoves(
    tx: DbTransaction,
    businessId: string,
    orderId: string,
    moves: OrderStockMove[],
  ): Promise<void> {
    for (const move of moves) {
      const delta = move.kind === 'sale' ? -move.quantity : move.quantity;

      if (move.variantId) {
        await tx
          .update(productVariants)
          .set({ stockCount: sql`greatest(${productVariants.stockCount} + ${delta}, 0)` })
          .where(
            and(eq(productVariants.id, move.variantId), eq(productVariants.businessId, businessId)),
          );
      }

      await tx
        .update(products)
        .set({
          stockCount: sql`greatest(${products.stockCount} + ${delta}, 0)`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(products.id, move.productId), eq(products.businessId, businessId)));

      await tx.insert(inventoryTransactions).values({
        businessId,
        productId: move.productId,
        type:
          move.kind === 'sale'
            ? InventoryTransactionType.DEDUCTION
            : InventoryTransactionType.RESTORATION,
        quantity: move.quantity,
        orderId,
        reason: move.kind === 'sale' ? 'Order confirmed' : 'Order cancelled or returned',
      });
    }
  }
}
