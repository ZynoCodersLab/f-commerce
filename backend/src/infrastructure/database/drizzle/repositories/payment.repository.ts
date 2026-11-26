import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getDb } from '../client.js';
import { getTenantId } from '../context.js';
import {
  auditLogs,
  businesses,
  orderItems,
  orders,
  orderStatusHistory,
  payments,
  users,
} from '../schema.js';
import { isUuid } from '../../../../domain/uuid.js';
import {
  Payment,
  PaymentKind,
  PaymentLedgerItem,
  PaymentMethod,
} from '../../../../domain/entities/financial.entity.js';
import {
  Order,
  OrderDetail,
  OrderItem,
  OrderStatusHistory,
} from '../../../../domain/entities/order.entity.js';
import {
  assertCanRecordPayment,
  assertCanRecordRefund,
  assertCanVoidPayment,
  computeOrderBalance,
} from '../../../../domain/order-payments.js';
import { NotFoundError } from '../../../../domain/errors.js';
import {
  BusinessPaymentSettings,
  IPaymentRepository,
  PaymentAuditWrite,
  PaymentLedgerFilter,
  PaymentLedgerResult,
  PaymentVoidWrite,
  PaymentWriteData,
} from '../../../../domain/repositories/payment.repository.js';

type DbTransaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

export function toPayment(row: typeof payments.$inferSelect): Payment {
  return {
    id: row.id,
    businessId: row.businessId,
    orderId: row.orderId,
    kind: row.kind,
    amount: row.amount,
    method: row.method,
    referenceNumber: row.referenceNumber ?? undefined,
    notes: row.notes ?? undefined,
    paymentDate: row.paymentDate,
    recordedByUserId: row.recordedByUserId,
    recordedByName: row.recordedByName,
    voidedAt: row.voidedAt ?? undefined,
    voidedByUserId: row.voidedByUserId ?? undefined,
    voidedByName: row.voidedByName ?? undefined,
    voidReason: row.voidReason ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

async function readDetailInTx(
  tx: DbTransaction,
  businessId: string,
  orderRow: typeof orders.$inferSelect,
  paymentRows: (typeof payments.$inferSelect)[],
): Promise<OrderDetail> {
  const [itemRows, historyRows] = await Promise.all([
    tx
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.orderId, orderRow.id), eq(orderItems.businessId, businessId)))
      .orderBy(asc(orderItems.position), asc(orderItems.createdAt), asc(orderItems.id)),
    tx
      .select()
      .from(orderStatusHistory)
      .where(
        and(
          eq(orderStatusHistory.orderId, orderRow.id),
          eq(orderStatusHistory.businessId, businessId),
        ),
      )
      .orderBy(asc(orderStatusHistory.createdAt), asc(orderStatusHistory.id)),
  ]);

  return {
    order: toOrder(orderRow),
    items: itemRows.map(toItem),
    history: historyRows.map(toHistory),
    payments: paymentRows.map(toPayment),
  };
}

export class DrizzlePaymentRepository implements IPaymentRepository {
  async orderExists(orderId: string): Promise<boolean> {
    const businessId = getTenantId();
    if (!businessId || !isUuid(orderId)) return false;

    const rows = await getDb()
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)));
    return rows.length > 0;
  }

  async findByIdempotencyKey(key: string): Promise<Payment | null> {
    const businessId = getTenantId();
    if (!businessId) return null;

    const rows = await getDb()
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.businessId, businessId),
          eq(payments.idempotencyKey, key),
          sql`${payments.idempotencyKey} IS NOT NULL`,
        ),
      );
    return rows.length === 0 ? null : toPayment(rows[0]);
  }

  async findBusinessSettings(): Promise<BusinessPaymentSettings | null> {
    const businessId = getTenantId();
    if (!businessId) return null;

    const rows = await getDb()
      .select({ currency: businesses.currency, timezone: businesses.timezone })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    return rows.length === 0 ? null : rows[0];
  }

  async findActorName(userId: string): Promise<string | null> {
    if (!isUuid(userId)) return null;
    const rows = await getDb().select({ name: users.name }).from(users).where(eq(users.id, userId));
    return rows.length === 0 ? null : rows[0].name;
  }

  async findOrderDetail(orderId: string): Promise<OrderDetail | null> {
    const businessId = getTenantId();
    if (!businessId || !isUuid(orderId)) return null;

    const orderRows = await getDb()
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)));
    if (orderRows.length === 0) return null;

    const [itemRows, historyRows, paymentRows] = await Promise.all([
      getDb()
        .select()
        .from(orderItems)
        .where(and(eq(orderItems.orderId, orderId), eq(orderItems.businessId, businessId)))
        .orderBy(asc(orderItems.position), asc(orderItems.createdAt), asc(orderItems.id)),
      getDb()
        .select()
        .from(orderStatusHistory)
        .where(
          and(
            eq(orderStatusHistory.orderId, orderId),
            eq(orderStatusHistory.businessId, businessId),
          ),
        )
        .orderBy(asc(orderStatusHistory.createdAt), asc(orderStatusHistory.id)),
      getDb()
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, orderId), eq(payments.businessId, businessId)))
        .orderBy(asc(payments.paymentDate), asc(payments.createdAt), asc(payments.id)),
    ]);

    return {
      order: toOrder(orderRows[0]),
      items: itemRows.map(toItem),
      history: historyRows.map(toHistory),
      payments: paymentRows.map(toPayment),
    };
  }

  async recordEntry(
    orderId: string,
    entry: PaymentWriteData,
    audit: PaymentAuditWrite,
  ): Promise<OrderDetail> {
    const businessId = getTenantId();
    if (!businessId || !isUuid(orderId)) {
      throw new NotFoundError('Order not found');
    }

    return await getDb().transaction(async (tx) => {
      // Lock the order row before reading payments or checking balance rules so
      // concurrent payments, refunds, voids, edits, and status changes serialize.
      const lockedOrders = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)))
        .for('update');
      if (lockedOrders.length === 0) {
        throw new NotFoundError('Order not found');
      }
      const lockedOrder = lockedOrders[0];

      const existingRows = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, orderId), eq(payments.businessId, businessId)))
        .orderBy(asc(payments.paymentDate), asc(payments.createdAt), asc(payments.id));

      const existingPayments = existingRows.map(toPayment);
      const currentBalance = computeOrderBalance(
        lockedOrder.status,
        lockedOrder.total,
        existingPayments,
      );

      if (entry.kind === PaymentKind.PAYMENT) {
        assertCanRecordPayment(lockedOrder.status, currentBalance.dueAmount, entry.amount);
      } else {
        assertCanRecordRefund(currentBalance.paidAmount, entry.amount);
      }

      const now = new Date();
      const insertedRows = await tx
        .insert(payments)
        .values({
          businessId,
          orderId,
          kind: entry.kind,
          amount: entry.amount,
          method: entry.method,
          paymentDate: entry.paymentDate,
          referenceNumber: entry.referenceNumber,
          notes: entry.notes,
          recordedByUserId: entry.recordedByUserId,
          recordedByName: entry.recordedByName,
          idempotencyKey: entry.idempotencyKey,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const inserted = insertedRows[0];
      const nextPayments = [...existingPayments, toPayment(inserted)];
      const nextBalance = computeOrderBalance(lockedOrder.status, lockedOrder.total, nextPayments);

      // Payment writes never change orders.version.
      const updatedOrders = await tx
        .update(orders)
        .set({
          paidAmount: nextBalance.paidAmount,
          dueAmount: nextBalance.dueAmount,
          updatedAt: now,
        })
        .where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)))
        .returning();

      await tx.insert(auditLogs).values({
        businessId: audit.businessId,
        userId: audit.userId,
        action: audit.action,
        entityType: 'PAYMENT',
        entityId: inserted.id,
        metadata: JSON.stringify({
          orderId,
          orderNumber: lockedOrder.orderNumber,
          kind: entry.kind,
          amount: entry.amount,
          method: entry.method,
        }),
      });

      const orderedPaymentRows = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, orderId), eq(payments.businessId, businessId)))
        .orderBy(asc(payments.paymentDate), asc(payments.createdAt), asc(payments.id));

      return readDetailInTx(tx, businessId, updatedOrders[0], orderedPaymentRows);
    });
  }

  async voidEntry(
    orderId: string,
    paymentId: string,
    voidWrite: PaymentVoidWrite,
    audit: PaymentAuditWrite,
  ): Promise<OrderDetail> {
    const businessId = getTenantId();
    if (!businessId || !isUuid(orderId) || !isUuid(paymentId)) {
      throw new NotFoundError('Payment not found');
    }

    return await getDb().transaction(async (tx) => {
      const lockedOrders = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)))
        .for('update');
      if (lockedOrders.length === 0) {
        throw new NotFoundError('Order not found');
      }
      const lockedOrder = lockedOrders[0];

      const existingRows = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, orderId), eq(payments.businessId, businessId)))
        .orderBy(asc(payments.paymentDate), asc(payments.createdAt), asc(payments.id));

      const existingPayments = existingRows.map(toPayment);
      const target = existingPayments.find((entry) => entry.id === paymentId);
      if (!target) {
        throw new NotFoundError('Payment not found');
      }

      const currentBalance = computeOrderBalance(
        lockedOrder.status,
        lockedOrder.total,
        existingPayments,
      );
      assertCanVoidPayment(lockedOrder.total, currentBalance.paidAmount, target);

      const now = new Date();
      await tx
        .update(payments)
        .set({
          voidedAt: now,
          voidedByUserId: voidWrite.voidedByUserId,
          voidedByName: voidWrite.voidedByName,
          voidReason: voidWrite.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(payments.id, paymentId),
            eq(payments.orderId, orderId),
            eq(payments.businessId, businessId),
          ),
        );

      const updatedPayments = existingPayments.map((entry) =>
        entry.id === paymentId ? { ...entry, voidedAt: now } : entry,
      );
      const nextBalance = computeOrderBalance(
        lockedOrder.status,
        lockedOrder.total,
        updatedPayments,
      );

      // Void writes never change orders.version.
      const updatedOrders = await tx
        .update(orders)
        .set({
          paidAmount: nextBalance.paidAmount,
          dueAmount: nextBalance.dueAmount,
          updatedAt: now,
        })
        .where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)))
        .returning();

      await tx.insert(auditLogs).values({
        businessId: audit.businessId,
        userId: audit.userId,
        action: audit.action,
        entityType: 'PAYMENT',
        entityId: paymentId,
        metadata: JSON.stringify({
          orderId,
          orderNumber: lockedOrder.orderNumber,
          kind: target.kind,
          amount: target.amount,
          method: target.method,
          reason: voidWrite.reason,
        }),
      });

      const orderedPaymentRows = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.orderId, orderId), eq(payments.businessId, businessId)))
        .orderBy(asc(payments.paymentDate), asc(payments.createdAt), asc(payments.id));

      return readDetailInTx(tx, businessId, updatedOrders[0], orderedPaymentRows);
    });
  }

  async listLedger(filter: PaymentLedgerFilter): Promise<PaymentLedgerResult> {
    const businessId = getTenantId();
    if (!businessId) {
      return { items: [], summary: { collected: 0, refunded: 0, net: 0 }, hasMore: false };
    }

    const baseConditions: SQL[] = [
      eq(payments.businessId, businessId),
      gte(payments.paymentDate, filter.from),
      lte(payments.paymentDate, filter.to),
    ];

    if (filter.methods.length > 0) {
      baseConditions.push(inArray(payments.method, filter.methods));
    }
    if (filter.kind !== undefined) {
      baseConditions.push(eq(payments.kind, filter.kind));
    }

    const pageConditions: SQL[] = [...baseConditions];
    if (
      filter.cursorPaymentDate !== undefined &&
      filter.cursorCreatedAt !== undefined &&
      filter.cursorId !== undefined &&
      isUuid(filter.cursorId)
    ) {
      const cursorCondition = or(
        sql`${payments.paymentDate} < ${filter.cursorPaymentDate}`,
        and(
          eq(payments.paymentDate, filter.cursorPaymentDate),
          sql`${payments.createdAt} < ${filter.cursorCreatedAt}`,
        ),
        and(
          eq(payments.paymentDate, filter.cursorPaymentDate),
          eq(payments.createdAt, filter.cursorCreatedAt),
          sql`${payments.id} < ${filter.cursorId}`,
        ),
      );
      if (cursorCondition) pageConditions.push(cursorCondition);
    }

    const [rows, summaryRows] = await Promise.all([
      getDb()
        .select({
          payment: payments,
          orderNumber: orders.orderNumber,
          customerNameSnapshot: orders.customerNameSnapshot,
        })
        .from(payments)
        .innerJoin(
          orders,
          and(eq(orders.id, payments.orderId), eq(orders.businessId, payments.businessId)),
        )
        .where(and(...pageConditions))
        .orderBy(desc(payments.paymentDate), desc(payments.createdAt), desc(payments.id))
        .limit(filter.limit + 1),
      getDb()
        .select({
          collected: sql<number>`coalesce(sum(case when ${payments.voidedAt} is null and ${payments.kind} = 'PAYMENT' then ${payments.amount} else 0 end), 0)::int`,
          refunded: sql<number>`coalesce(sum(case when ${payments.voidedAt} is null and ${payments.kind} = 'REFUND' then ${payments.amount} else 0 end), 0)::int`,
        })
        .from(payments)
        .where(and(...baseConditions)),
    ]);

    const hasMore = rows.length > filter.limit;
    const pageRows = hasMore ? rows.slice(0, filter.limit) : rows;
    const items: PaymentLedgerItem[] = pageRows.map((row) => ({
      ...toPayment(row.payment),
      orderNumber: row.orderNumber,
      customerNameSnapshot: row.customerNameSnapshot,
    }));

    const collected = Number(summaryRows[0]?.collected ?? 0);
    const refunded = Number(summaryRows[0]?.refunded ?? 0);
    return {
      items,
      summary: { collected, refunded, net: collected - refunded },
      hasMore,
    };
  }
}

export type { PaymentMethod };
