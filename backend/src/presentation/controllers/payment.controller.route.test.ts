import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { and, eq } from 'drizzle-orm';
import { orderRouter } from './order.controller.js';
import { paymentRouter } from './payment.controller.js';
import { businessRouter } from './business.controller.js';
import { customerRouter } from './customer.controller.js';
import { config } from '../../infrastructure/config.js';
import { getDb } from '../../infrastructure/database/drizzle/client.js';
import {
  auditLogs,
  businessMembers,
  businesses,
  categories,
  customers,
  orderStatusHistory,
  orders,
  payments,
  products,
  users,
} from '../../infrastructure/database/drizzle/schema.js';
import {
  startPg,
  stopPg,
  resetDatabase,
  seedMembership,
  getTestPool,
} from '../../test-support/pg-test-database.js';
import { todayInTimeZone } from '../../domain/timezone.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(HERE, '..', '..', '..', 'drizzle', 'migrations');

const app = express();
app.use(express.json());
app.use('/api/orders', orderRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/business', businessRouter);
app.use('/api/customers', customerRouter);

const BIZ = '00000000-0000-0000-0000-0000000001a1';
const USD_BIZ = '00000000-0000-0000-0000-0000000001b2';
const OTHER_BIZ = '00000000-0000-0000-0000-0000000001c3';
const OWNER = '00000000-0000-0000-0000-0000000001d4';
const STAFF = '00000000-0000-0000-0000-0000000001e5';
const OUTSIDER = '00000000-0000-0000-0000-0000000001f6';

function tokenFor(
  userId: string,
  memberships: { businessId: string; role: 'OWNER' | 'STAFF' }[],
): string {
  return jwt.sign({ userId, memberships }, config.JWT_SECRET);
}

const OWNER_TOKEN = tokenFor(OWNER, [
  { businessId: BIZ, role: 'OWNER' },
  { businessId: USD_BIZ, role: 'OWNER' },
]);
const STAFF_TOKEN = tokenFor(STAFF, [{ businessId: BIZ, role: 'STAFF' }]);
const OUTSIDER_TOKEN = tokenFor(OUTSIDER, [{ businessId: OTHER_BIZ, role: 'OWNER' }]);

function as(token: string, businessId = BIZ) {
  return { authorization: `Bearer ${token}`, 'x-business-id': businessId };
}

interface Fixtures {
  customerId: string;
  archivedCustomerId: string;
  productId: string;
  usdCustomerId: string;
  usdProductId: string;
  otherCustomerId: string;
  otherProductId: string;
}

let fixtures: Fixtures;

async function seedFixtures(): Promise<void> {
  await getDb()
    .insert(businesses)
    .values([
      {
        id: BIZ,
        name: 'Dhaka Shop',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        onboardingComplete: true,
      },
      {
        id: USD_BIZ,
        name: 'New York Shop',
        currency: 'USD',
        timezone: 'America/New_York',
        onboardingComplete: true,
      },
      {
        id: OTHER_BIZ,
        name: 'Other Shop',
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        onboardingComplete: true,
      },
    ]);

  await getDb()
    .insert(users)
    .values([
      { id: OWNER, email: 'owner-pay@example.com', name: 'Maya Owner' },
      { id: STAFF, email: 'staff-pay@example.com', name: 'Sam Staff' },
      { id: OUTSIDER, email: 'outsider-pay@example.com', name: 'Other Owner' },
    ]);

  await seedMembership(BIZ, OWNER, 'OWNER');
  await seedMembership(BIZ, STAFF, 'STAFF');
  await seedMembership(USD_BIZ, OWNER, 'OWNER');
  await seedMembership(OTHER_BIZ, OUTSIDER, 'OWNER');

  const [catBiz] = await getDb()
    .insert(categories)
    .values({ businessId: BIZ, name: 'Apparel' })
    .returning({ id: categories.id });
  const [catUsd] = await getDb()
    .insert(categories)
    .values({ businessId: USD_BIZ, name: 'Goods' })
    .returning({ id: categories.id });
  const [catOther] = await getDb()
    .insert(categories)
    .values({ businessId: OTHER_BIZ, name: 'Other' })
    .returning({ id: categories.id });

  const [customer] = await getDb()
    .insert(customers)
    .values({ businessId: BIZ, name: 'Nusrat Jahan', phone: '+8801711111111' })
    .returning({ id: customers.id });
  const [archivedCustomer] = await getDb()
    .insert(customers)
    .values({
      businessId: BIZ,
      name: 'Archived Buyer',
      phone: '+8801722222222',
      archivedAt: new Date(),
    })
    .returning({ id: customers.id });
  const [usdCustomer] = await getDb()
    .insert(customers)
    .values({ businessId: USD_BIZ, name: 'Alex Buyer', phone: '+12125550101' })
    .returning({ id: customers.id });
  const [otherCustomer] = await getDb()
    .insert(customers)
    .values({ businessId: OTHER_BIZ, name: 'Stranger Buyer', phone: '+8801733333333' })
    .returning({ id: customers.id });

  const [product] = await getDb()
    .insert(products)
    .values({
      businessId: BIZ,
      categoryId: catBiz.id,
      name: 'Cotton Shirt',
      price: 1000,
      cost: 600,
      stockCount: 20,
    })
    .returning({ id: products.id });
  const [usdProduct] = await getDb()
    .insert(products)
    .values({
      businessId: USD_BIZ,
      categoryId: catUsd.id,
      name: 'Jacket',
      price: 100,
      cost: 50,
      stockCount: 10,
    })
    .returning({ id: products.id });
  const [otherProduct] = await getDb()
    .insert(products)
    .values({
      businessId: OTHER_BIZ,
      categoryId: catOther.id,
      name: 'Other Item',
      price: 500,
      stockCount: 10,
    })
    .returning({ id: products.id });

  fixtures = {
    customerId: customer.id,
    archivedCustomerId: archivedCustomer.id,
    productId: product.id,
    usdCustomerId: usdCustomer.id,
    usdProductId: usdProduct.id,
    otherCustomerId: otherCustomer.id,
    otherProductId: otherProduct.id,
  };
}

function createOrder(
  body: Record<string, unknown>,
  options: { token?: string; businessId?: string; idempotencyKey?: string } = {},
) {
  const call = request(app)
    .post('/api/orders')
    .set(as(options.token ?? OWNER_TOKEN, options.businessId ?? BIZ));
  if (options.idempotencyKey !== undefined) {
    call.set('Idempotency-Key', options.idempotencyKey);
  }
  return call.send(body);
}

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    customerId: fixtures.customerId,
    items: [{ productId: fixtures.productId, quantity: 1 }],
    source: 'FACEBOOK',
    confirmDuplicate: true,
    ...overrides,
  };
}

function shiftIsoDate(isoDate: string, deltaDays: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function paymentRowsFor(orderId: string) {
  return getDb().select().from(payments).where(eq(payments.orderId, orderId));
}

async function auditRowsFor(orderId: string, businessId = BIZ) {
  return getDb()
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.businessId, businessId), eq(auditLogs.entityId, orderId)));
}

async function installFailingAuditTrigger(): Promise<void> {
  const pool = getTestPool();
  await pool.query(`
    CREATE OR REPLACE FUNCTION reject_payment_audit() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced audit failure';
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS reject_payment_audit_trg ON audit_logs;
    CREATE TRIGGER reject_payment_audit_trg
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_payment_audit();
  `);
}

async function removeFailingAuditTrigger(): Promise<void> {
  const pool = getTestPool();
  await pool.query(`
    DROP TRIGGER IF EXISTS reject_payment_audit_trg ON audit_logs;
    DROP FUNCTION IF EXISTS reject_payment_audit();
  `);
}

function migrationScratchUrl(name: string): { adminUrl: string; targetUrl: string } {
  const base =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://postgres:local@localhost:5432/f-commerce-test';
  const target = new URL(base);
  target.pathname = `/${name}`;
  const admin = new URL(base);
  admin.pathname = '/postgres';
  return { adminUrl: admin.toString(), targetUrl: target.toString() };
}

async function runMigrationFiles(pool: Pool, files: string[]): Promise<void> {
  for (const file of files) {
    const content = await fs.readFile(path.join(MIGRATIONS_FOLDER, file), 'utf8');
    const statements = content
      .split('--> statement-breakpoint')
      .map((stmt) => stmt.trim())
      .filter((stmt) => stmt.length > 0);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
  }
}

describe('payment routes and invariants against PostgreSQL', () => {
  beforeAll(async () => {
    await startPg();
  }, 60_000);

  afterAll(async () => {
    await stopPg();
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase();
    await seedFixtures();
  });

  describe('initialPayment at order creation (AC-1, AC-2)', () => {
    it('creates an order with CASH_ON_DELIVERY initialPayment, null payment key, and separate audit rows', async () => {
      const todayDhaka = todayInTimeZone('Asia/Dhaka');
      const res = await createOrder(
        baseOrder({
          initialPayment: {
            amount: 400,
            method: 'CASH_ON_DELIVERY',
            referenceNumber: 'COD-88',
            notes: 'Driver advance',
          },
        }),
        { idempotencyKey: 'ord-key-1' },
      );

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        total: 1000,
        paidAmount: 400,
        dueAmount: 600,
        refundOwed: 0,
        paymentStatus: 'PARTIAL',
      });
      expect(res.body.data.payments).toHaveLength(1);
      expect(res.body.data.payments[0]).toMatchObject({
        kind: 'PAYMENT',
        amount: 400,
        method: 'CASH_ON_DELIVERY',
        paymentDate: todayDhaka,
        referenceNumber: 'COD-88',
        notes: 'Driver advance',
        recordedByName: 'Maya Owner',
        voidedAt: null,
      });

      const orderId = res.body.data.id as string;
      const dbPayments = await paymentRowsFor(orderId);
      expect(dbPayments).toHaveLength(1);
      expect(dbPayments[0].idempotencyKey).toBeNull();
      expect(dbPayments[0].recordedByUserId).toBe(OWNER);

      const orderAudits = await auditRowsFor(orderId);
      const createdAudit = orderAudits.find((a) => a.action === 'ORDER_CREATED');
      const paymentAudits = await auditRowsFor(dbPayments[0].id);
      const paidAudit = paymentAudits.find((a) => a.action === 'PAYMENT_RECORDED');
      expect(JSON.parse(createdAudit?.metadata ?? '{}')).toEqual({
        orderNumber: res.body.data.orderNumber,
        total: 1000,
      });
      expect(paidAudit?.entityType).toBe('PAYMENT');
      expect(JSON.parse(paidAudit?.metadata ?? '{}')).toEqual({
        orderId,
        orderNumber: res.body.data.orderNumber,
        kind: 'PAYMENT',
        amount: 400,
        method: 'CASH_ON_DELIVERY',
      });

      // Replaying POST /api/orders with the same Idempotency-Key returns stored payments without inserting a duplicate.
      const replay = await createOrder(
        baseOrder({
          initialPayment: { amount: 400, method: 'CASH_ON_DELIVERY' },
        }),
        { idempotencyKey: 'ord-key-1' },
      );
      expect(replay.status).toBe(200);
      expect(replay.body.data.payments).toHaveLength(1);
      expect(await paymentRowsFor(orderId)).toHaveLength(1);
    });

    it('validates initialPayment fields before the duplicate 409 check and skips payment on duplicate 409', async () => {
      const first = await createOrder(baseOrder({ confirmDuplicate: false }));
      expect(first.status).toBe(201);

      // Amount over total returns 400 naming initialPayment.amount before 409 DUPLICATE_ORDER.
      const overTotal = await createOrder(
        baseOrder({
          confirmDuplicate: false,
          initialPayment: { amount: 1500, method: 'CASH' },
        }),
      );
      expect(overTotal.status).toBe(400);
      expect(overTotal.body.error).toBe('VALIDATION_ERROR');
      expect(overTotal.body.fields).toContain('initialPayment.amount');

      // Future payment date returns 400 naming initialPayment.paymentDate before 409.
      const tomorrowDhaka = shiftIsoDate(todayInTimeZone('Asia/Dhaka'), 1);
      const futureDate = await createOrder(
        baseOrder({
          confirmDuplicate: false,
          initialPayment: { amount: 500, method: 'CASH', paymentDate: tomorrowDhaka },
        }),
      );
      expect(futureDate.status).toBe(400);
      expect(futureDate.body.fields).toContain('initialPayment.paymentDate');

      // BKASH on USD business returns 400 naming initialPayment.method.
      const badMethod = await createOrder(
        {
          customerId: fixtures.usdCustomerId,
          items: [{ productId: fixtures.usdProductId, quantity: 1 }],
          source: 'DIRECT',
          initialPayment: { amount: 50, method: 'BKASH' },
        },
        { businessId: USD_BIZ },
      );
      expect(badMethod.status).toBe(400);
      expect(badMethod.body.fields).toContain('initialPayment.method');

      // Duplicate 409 writes no payment; confirmDuplicate: true writes both.
      const duplicate = await createOrder(
        baseOrder({
          confirmDuplicate: false,
          initialPayment: { amount: 500, method: 'BKASH' },
        }),
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toBe('DUPLICATE_ORDER');
      const allPaymentsBefore = await getDb().select().from(payments);
      expect(allPaymentsBefore).toHaveLength(0);

      const confirmed = await createOrder(
        baseOrder({
          confirmDuplicate: true,
          initialPayment: { amount: 500, method: 'BKASH' },
        }),
      );
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.data.paidAmount).toBe(500);
      expect(confirmed.body.data.payments).toHaveLength(1);
    });
  });

  describe('recording payments, refunds, voids, and concurrency (AC-3, AC-4, AC-5, AC-6, AC-7)', () => {
    it('records partial and settling payments without bumping version or status history, and rejects overpayment or closed orders', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id as string;
      const beforeUpdatedAt = created.body.data.updatedAt as string;

      const partial = await request(app)
        .post(`/api/orders/${orderId}/payments`)
        .set(as(STAFF_TOKEN))
        .set('Idempotency-Key', 'pay-1')
        .send({ amount: 300, method: 'BKASH', referenceNumber: 'TRX-1' });
      expect(partial.status).toBe(201);
      expect(partial.body.data).toMatchObject({
        paidAmount: 300,
        dueAmount: 700,
        paymentStatus: 'PARTIAL',
        version: 1,
      });
      expect(new Date(partial.body.data.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(beforeUpdatedAt).getTime(),
      );
      expect(partial.body.data.payments[0].recordedByName).toBe('Sam Staff');

      const overpay = await request(app)
        .post(`/api/orders/${orderId}/payments`)
        .set(as(STAFF_TOKEN))
        .send({ amount: 701, method: 'CASH' });
      expect(overpay.status).toBe(409);
      expect(overpay.body).toMatchObject({
        error: 'PAYMENT_EXCEEDS_DUE',
        dueAmount: 700,
      });

      const settle = await request(app)
        .post(`/api/orders/${orderId}/payments`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 700, method: 'NAGAD' });
      expect(settle.status).toBe(201);
      expect(settle.body.data).toMatchObject({
        paidAmount: 1000,
        dueAmount: 0,
        paymentStatus: 'PAID',
        version: 1,
      });

      // No status history rows were added by payments.
      const historyRows = await getDb()
        .select()
        .from(orderStatusHistory)
        .where(eq(orderStatusHistory.orderId, orderId));
      expect(historyRows).toHaveLength(1);

      // Payments are rejected on CANCELLED orders with 409 ORDER_CLOSED.
      const cancelRes = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 1 });
      expect(cancelRes.status).toBe(200);

      const onClosed = await request(app)
        .post(`/api/orders/${orderId}/payments`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 100, method: 'CASH' });
      expect(onClosed.status).toBe(409);
      expect(onClosed.body.error).toBe('ORDER_CLOSED');
    });

    it('serializes two concurrent payments on the same order so total paid never exceeds order total', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id as string;

      const [first, second] = await Promise.all([
        request(app)
          .post(`/api/orders/${orderId}/payments`)
          .set(as(OWNER_TOKEN))
          .send({ amount: 600, method: 'CASH' }),
        request(app)
          .post(`/api/orders/${orderId}/payments`)
          .set(as(STAFF_TOKEN))
          .send({ amount: 600, method: 'BKASH' }),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const conflict = first.status === 409 ? first : second;
      expect(conflict.body).toMatchObject({ error: 'PAYMENT_EXCEEDS_DUE', dueAmount: 400 });

      const detail = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(detail.body.data).toMatchObject({ paidAmount: 600, dueAmount: 400 });
      expect(detail.body.data.payments).toHaveLength(1);
    });

    it('enforces OWNER-only refunds on active and closed orders and rejects amounts above paidAmount', async () => {
      const created = await createOrder(
        baseOrder({ initialPayment: { amount: 1000, method: 'BKASH' } }),
      );
      const orderId = created.body.data.id as string;

      const staffRefund = await request(app)
        .post(`/api/orders/${orderId}/refunds`)
        .set(as(STAFF_TOKEN))
        .send({ amount: 200, method: 'BKASH' });
      expect(staffRefund.status).toBe(403);

      const tooLarge = await request(app)
        .post(`/api/orders/${orderId}/refunds`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 1001, method: 'BKASH' });
      expect(tooLarge.status).toBe(409);
      expect(tooLarge.body).toMatchObject({ error: 'REFUND_EXCEEDS_PAID', paidAmount: 1000 });

      // Refund on active order restores dueAmount.
      const activeRefund = await request(app)
        .post(`/api/orders/${orderId}/refunds`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 300, method: 'BKASH', notes: 'Partial price adjustment' });
      expect(activeRefund.status).toBe(201);
      expect(activeRefund.body.data).toMatchObject({
        paidAmount: 700,
        dueAmount: 300,
        refundOwed: 0,
        paymentStatus: 'PARTIAL',
      });

      // Cancel order -> refundOwed becomes 700, dueAmount becomes 0.
      const cancelled = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 1 });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data).toMatchObject({
        paidAmount: 700,
        dueAmount: 0,
        refundOwed: 700,
        paymentStatus: 'REFUND_OWED',
      });

      // Full refund on closed order clears refundOwed and sets paymentStatus to NONE.
      const closedRefund = await request(app)
        .post(`/api/orders/${orderId}/refunds`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 700, method: 'BKASH' });
      expect(closedRefund.status).toBe(201);
      expect(closedRefund.body.data).toMatchObject({
        paidAmount: 0,
        dueAmount: 0,
        refundOwed: 0,
        paymentStatus: 'NONE',
      });
    });

    it('handles OWNER-only voids, reason validation, balance guards, 404 scoping, and ignores Idempotency-Key', async () => {
      const created = await createOrder(
        baseOrder({ initialPayment: { amount: 1000, method: 'CASH' } }),
      );
      const orderId = created.body.data.id as string;
      const firstPaymentId = created.body.data.payments[0].id as string;

      // Staff cannot void.
      const staffVoid = await request(app)
        .post(`/api/orders/${orderId}/payments/${firstPaymentId}/void`)
        .set(as(STAFF_TOKEN))
        .send({ reason: 'Wrong amount' });
      expect(staffVoid.status).toBe(403);

      // Blank reason returns 400 naming reason.
      const blankReason = await request(app)
        .post(`/api/orders/${orderId}/payments/${firstPaymentId}/void`)
        .set(as(OWNER_TOKEN))
        .send({ reason: '   ' });
      expect(blankReason.status).toBe(400);
      expect(blankReason.body.fields).toContain('reason');

      // Record a 400 refund so paid=600.
      const refunded = await request(app)
        .post(`/api/orders/${orderId}/refunds`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 400, method: 'CASH' });
      expect(refunded.status).toBe(201);
      const refundId = refunded.body.data.payments[1].id as string;

      // Voiding the 1000 payment while the 400 refund is live would drop paidAmount to -400 -> 409 VOID_BREAKS_BALANCE.
      const breaksNegative = await request(app)
        .post(`/api/orders/${orderId}/payments/${firstPaymentId}/void`)
        .set(as(OWNER_TOKEN))
        .send({ reason: 'Try breaking balance' });
      expect(breaksNegative.status).toBe(409);
      expect(breaksNegative.body).toMatchObject({
        error: 'VOID_BREAKS_BALANCE',
        paidAmount: 600,
        total: 1000,
      });

      // Lower order total to 700 (allowed since paid is 600), cancel order, then try to void the 400 refund:
      // net would become 1000 > total 700 -> must return 409 VOID_BREAKS_BALANCE, never 500.
      const edited = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, discount: 300 });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ total: 700, paidAmount: 600, dueAmount: 100 });

      const cancelled = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 2 });
      expect(cancelled.status).toBe(200);

      const breaksTotal = await request(app)
        .post(`/api/orders/${orderId}/payments/${refundId}/void`)
        .set(as(OWNER_TOKEN))
        .send({ reason: 'Would exceed reduced total' });
      expect(breaksTotal.status).toBe(409);
      expect(breaksTotal.body).toMatchObject({
        error: 'VOID_BREAKS_BALANCE',
        paidAmount: 600,
        total: 700,
      });

      // Fresh order for clean void + repeat void (ignoring Idempotency-Key) + cross-order 404.
      const secondOrder = await createOrder(
        baseOrder({ initialPayment: { amount: 500, method: 'CASH' } }),
      );
      const secondOrderId = secondOrder.body.data.id as string;
      const secondPayId = secondOrder.body.data.payments[0].id as string;

      // Cross-order paymentId returns 404.
      const crossOrder = await request(app)
        .post(`/api/orders/${orderId}/payments/${secondPayId}/void`)
        .set(as(OWNER_TOKEN))
        .send({ reason: 'Wrong order' });
      expect(crossOrder.status).toBe(404);

      // Bad UUID returns 404.
      const badUuid = await request(app)
        .post(`/api/orders/${secondOrderId}/payments/not-a-uuid/void`)
        .set(as(OWNER_TOKEN))
        .send({ reason: 'Bad id' });
      expect(badUuid.status).toBe(404);

      const voided = await request(app)
        .post(`/api/orders/${secondOrderId}/payments/${secondPayId}/void`)
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', 'ignored-void-key')
        .send({ reason: 'Duplicate entry' });
      expect(voided.status).toBe(200);
      expect(voided.body.data).toMatchObject({
        paidAmount: 0,
        dueAmount: 1000,
        paymentStatus: 'UNPAID',
      });
      expect(voided.body.data.payments[0]).toMatchObject({
        voidedByName: 'Maya Owner',
        voidReason: 'Duplicate entry',
      });
      expect(voided.body.data.payments[0].voidedAt).not.toBeNull();
      const [voidedRow] = await paymentRowsFor(secondOrderId);
      expect(voidedRow.voidedByUserId).toBe(OWNER);

      // Repeat void even with the same Idempotency-Key returns 409 PAYMENT_ALREADY_VOIDED.
      const repeat = await request(app)
        .post(`/api/orders/${secondOrderId}/payments/${secondPayId}/void`)
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', 'ignored-void-key')
        .send({ reason: 'Duplicate entry' });
      expect(repeat.status).toBe(409);
      expect(repeat.body.error).toBe('PAYMENT_ALREADY_VOIDED');
    });
  });

  describe('order edits, status closing, stock restoration, and races (AC-8, AC-9)', () => {
    it('zeroes dueAmount and restores stock on cancel, and handles concurrent payment vs cancel cleanly', async () => {
      const created = await createOrder(
        baseOrder({ initialPayment: { amount: 400, method: 'BKASH' } }),
      );
      const orderId = created.body.data.id as string;

      // Confirm (deducts 1 stock: 20 -> 19), then cancel (restores 1 stock: 19 -> 20, dueAmount -> 0).
      const confirmed = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      expect(confirmed.status).toBe(200);

      const cancelled = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 2 });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data).toMatchObject({
        status: 'CANCELLED',
        paidAmount: 400,
        dueAmount: 0,
        refundOwed: 400,
        paymentStatus: 'REFUND_OWED',
      });

      const [prod] = await getDb()
        .select({ stockCount: products.stockCount })
        .from(products)
        .where(eq(products.id, fixtures.productId));
      expect(prod.stockCount).toBe(20);

      // Concurrent payment vs cancel race keeps invariants intact regardless of winner order.
      const raceOrder = await createOrder(baseOrder());
      const raceId = raceOrder.body.data.id as string;
      const [payRes, cancelRaceRes] = await Promise.all([
        request(app)
          .post(`/api/orders/${raceId}/payments`)
          .set(as(OWNER_TOKEN))
          .send({ amount: 500, method: 'CASH' }),
        request(app)
          .post(`/api/orders/${raceId}/status`)
          .set(as(OWNER_TOKEN))
          .send({ status: 'CANCELLED', version: 1 }),
      ]);
      expect(cancelRaceRes.status).toBe(200);
      expect([201, 409]).toContain(payRes.status);
      if (payRes.status === 409) {
        expect(payRes.body.error).toBe('ORDER_CLOSED');
      }

      const finalOrder = await request(app).get(`/api/orders/${raceId}`).set(as(OWNER_TOKEN));
      expect(finalOrder.body.data.status).toBe('CANCELLED');
      expect(finalOrder.body.data.dueAmount).toBe(0);
      expect(finalOrder.body.data.refundOwed).toBe(finalOrder.body.data.paidAmount);
    });

    it('enforces exact PATCH check order, returns payments on no-op edit, and serializes edit vs payment', async () => {
      const created = await createOrder(
        baseOrder({ initialPayment: { amount: 600, method: 'CASH' } }),
      );
      const orderId = created.body.data.id as string;

      // 1. TOTAL_BELOW_PAID checked BEFORE ORDER_CHANGED (stale version 99 + total 500 < paid 600).
      const belowPaid = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 99, discount: 500 });
      expect(belowPaid.status).toBe(409);
      expect(belowPaid.body).toMatchObject({ error: 'TOTAL_BELOW_PAID', paidAmount: 600 });

      // 2. ORDER_CHANGED checked BEFORE CUSTOMER_ARCHIVED (stale version 99 + archived customer).
      const staleWithArchived = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 99, customerId: fixtures.archivedCustomerId });
      expect(staleWithArchived.status).toBe(409);
      expect(staleWithArchived.body.error).toBe('ORDER_CHANGED');

      // 3. No-op edit returns full order detail including payments.
      const noop = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, notes: null });
      expect(noop.status).toBe(200);
      expect(noop.body.data.payments).toHaveLength(1);
      expect(noop.body.data.paidAmount).toBe(600);

      // 4. ORDER_LOCKED checked BEFORE TOTAL_BELOW_PAID when order is PROCESSING.
      await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'PROCESSING', version: 2 });

      const lockedBelowPaid = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 3, discount: 500 });
      expect(lockedBelowPaid.status).toBe(409);
      expect(lockedBelowPaid.body.error).toBe('ORDER_LOCKED');

      // 5. Concurrent payment (800) vs edit lowering total to 700 keeps paidAmount <= total.
      const raceOrder = await createOrder(baseOrder());
      const raceId = raceOrder.body.data.id as string;
      const [payRes, editRes] = await Promise.all([
        request(app)
          .post(`/api/orders/${raceId}/payments`)
          .set(as(OWNER_TOKEN))
          .send({ amount: 800, method: 'CASH' }),
        request(app)
          .patch(`/api/orders/${raceId}`)
          .set(as(OWNER_TOKEN))
          .send({ version: 1, discount: 300 }),
      ]);
      const okCount = [payRes.status === 201, editRes.status === 200].filter(Boolean).length;
      const conflictCount = [payRes.status === 409, editRes.status === 409].filter(Boolean).length;
      expect(okCount).toBe(1);
      expect(conflictCount).toBe(1);
      if (payRes.status === 409) {
        expect(payRes.body.error).toBe('PAYMENT_EXCEEDS_DUE');
      } else {
        expect(editRes.body.error).toBe('TOTAL_BELOW_PAID');
      }

      const finalOrder = await request(app).get(`/api/orders/${raceId}`).set(as(OWNER_TOKEN));
      expect(finalOrder.body.data.paidAmount).toBeLessThanOrEqual(finalOrder.body.data.total);
      expect(finalOrder.body.data.dueAmount).toBe(
        finalOrder.body.data.total - finalOrder.body.data.paidAmount,
      );
    });
  });

  describe('order list paymentStatus filter and customer totalDue (AC-10)', () => {
    it('filters orders across every paymentStatus, rejects NONE, binds cursors, and keeps customer orders totalDue accurate', async () => {
      // 1. UNPAID active
      const unpaid = await createOrder(baseOrder());
      // 2. PARTIAL active
      const partial = await createOrder(
        baseOrder({ initialPayment: { amount: 400, method: 'CASH' } }),
      );
      // 3. PAID active
      const paid = await createOrder(
        baseOrder({ initialPayment: { amount: 1000, method: 'CASH' } }),
      );
      // 4. Total-0 active -> PAID
      const freeOrder = await createOrder(baseOrder({ discount: 1000 }));
      // 5. REFUND_OWED closed
      const refundOwedOrder = await createOrder(
        baseOrder({ initialPayment: { amount: 500, method: 'BKASH' } }),
      );
      await request(app)
        .post(`/api/orders/${refundOwedOrder.body.data.id}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 1 });
      // 6. NONE closed (cancelled with 0 paid)
      const noneOrder = await createOrder(baseOrder());
      await request(app)
        .post(`/api/orders/${noneOrder.body.data.id}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 1 });

      // Rejects NONE with 400 naming paymentStatus.
      const badFilter = await request(app)
        .get('/api/orders?paymentStatus=NONE')
        .set(as(OWNER_TOKEN));
      expect(badFilter.status).toBe(400);
      expect(badFilter.body.fields).toContain('paymentStatus');

      const unpaidList = await request(app)
        .get('/api/orders?paymentStatus=UNPAID')
        .set(as(OWNER_TOKEN));
      expect(unpaidList.status).toBe(200);
      expect(unpaidList.body.data.items.map((i: { id: string }) => i.id)).toEqual([
        unpaid.body.data.id,
      ]);

      const hasDueList = await request(app)
        .get('/api/orders?paymentStatus=UNPAID,PARTIAL')
        .set(as(OWNER_TOKEN));
      expect(hasDueList.status).toBe(200);
      expect(hasDueList.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [unpaid.body.data.id, partial.body.data.id].sort(),
      );

      const paidList = await request(app)
        .get('/api/orders?paymentStatus=PAID')
        .set(as(OWNER_TOKEN));
      expect(paidList.status).toBe(200);
      expect(paidList.body.data.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [paid.body.data.id, freeOrder.body.data.id].sort(),
      );

      const refundOwedList = await request(app)
        .get('/api/orders?paymentStatus=REFUND_OWED')
        .set(as(OWNER_TOKEN));
      expect(refundOwedList.status).toBe(200);
      expect(refundOwedList.body.data.items.map((i: { id: string }) => i.id)).toEqual([
        refundOwedOrder.body.data.id,
      ]);

      // Cursor binding rejects mismatched paymentStatus with 400 naming cursor.
      const page1 = await request(app)
        .get('/api/orders?paymentStatus=UNPAID,PARTIAL&limit=1')
        .set(as(OWNER_TOKEN));
      expect(page1.status).toBe(200);
      expect(page1.body.data.nextCursor).toBeTruthy();

      const mismatched = await request(app)
        .get(
          `/api/orders?paymentStatus=PAID&limit=1&cursor=${encodeURIComponent(page1.body.data.nextCursor)}`,
        )
        .set(as(OWNER_TOKEN));
      expect(mismatched.status).toBe(400);
      expect(mismatched.body.fields).toContain('cursor');

      // Customer profile totalDue reflects payments (1000 unpaid + 600 partial due = 1600; cancelled orders contribute 0),
      // and GET /api/customers/:id/orders keeps its existing item shape.
      const customerProfile = await request(app)
        .get(`/api/customers/${fixtures.customerId}`)
        .set(as(OWNER_TOKEN));
      expect(customerProfile.status).toBe(200);
      expect(customerProfile.body.data.totalDue).toBe(1600);

      const customerOrders = await request(app)
        .get(`/api/customers/${fixtures.customerId}/orders`)
        .set(as(OWNER_TOKEN));
      expect(customerOrders.status).toBe(200);
      expect(Object.keys(customerOrders.body.data.items[0]).sort()).toEqual([
        'createdAt',
        'dueAmount',
        'id',
        'orderNumber',
        'status',
        'total',
      ]);
    });
  });

  describe('ordering, snapshots, idempotency, currency, dates, atomicity, and live role (AC-11..AC-16)', () => {
    it('preserves oldest-first order and actor name snapshots after user rename', async () => {
      const created = await createOrder(
        baseOrder({ initialPayment: { amount: 200, method: 'CASH' } }),
      );
      const orderId = created.body.data.id as string;

      const second = await request(app)
        .post(`/api/orders/${orderId}/payments`)
        .set(as(STAFF_TOKEN))
        .send({ amount: 300, method: 'BKASH' });
      expect(second.status).toBe(201);

      await getDb().update(users).set({ name: 'Renamed Owner' }).where(eq(users.id, OWNER));
      await getDb().update(users).set({ name: 'Renamed Staff' }).where(eq(users.id, STAFF));

      const detail = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(detail.status).toBe(200);
      expect(detail.body.data.payments).toHaveLength(2);
      expect(detail.body.data.payments[0]).toMatchObject({
        amount: 200,
        recordedByName: 'Maya Owner',
      });
      expect(detail.body.data.payments[1]).toMatchObject({
        amount: 300,
        recordedByName: 'Sam Staff',
      });
    });

    it('enforces Idempotency-Key validation, 404 before key lookup, same-order replay, cross-order/kind conflict, and races', async () => {
      const orderA = await createOrder(baseOrder());
      const orderB = await createOrder(baseOrder());
      const idA = orderA.body.data.id as string;
      const idB = orderB.body.data.id as string;

      // Blank or overly long Idempotency-Key returns 400 naming Idempotency-Key.
      const blankKey = await request(app)
        .post(`/api/orders/${idA}/payments`)
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', '   ')
        .send({ amount: 100, method: 'CASH' });
      expect(blankKey.status).toBe(400);
      expect(blankKey.body.fields).toContain('Idempotency-Key');

      const longKey = await request(app)
        .post(`/api/orders/${idA}/payments`)
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', 'k'.repeat(101))
        .send({ amount: 100, method: 'CASH' });
      expect(longKey.status).toBe(400);
      expect(longKey.body.fields).toContain('Idempotency-Key');

      // First payment stores the key.
      const first = await request(app)
        .post(`/api/orders/${idA}/payments`)
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', 'pay-idem-1')
        .send({ amount: 250, method: 'CASH' });
      expect(first.status).toBe(201);

      // Unknown order id returns 404 BEFORE key lookup.
      const unknownOrder = await request(app)
        .post('/api/orders/00000000-0000-4000-8000-000000000000/payments')
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', 'pay-idem-1')
        .send({ amount: 250, method: 'CASH' });
      expect(unknownOrder.status).toBe(404);

      // Same order + same kind replays with 200 BEFORE body validation.
      const replay = await request(app)
        .post(`/api/orders/${idA}/payments`)
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', 'pay-idem-1')
        .send({ amount: -999, method: 'INVALID' });
      expect(replay.status).toBe(200);
      expect(replay.body.data.paidAmount).toBe(250);
      expect(await paymentRowsFor(idA)).toHaveLength(1);

      // Same key on another order returns 409 IDEMPOTENCY_KEY_CONFLICT.
      const crossOrder = await request(app)
        .post(`/api/orders/${idB}/payments`)
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', 'pay-idem-1')
        .send({ amount: 250, method: 'CASH' });
      expect(crossOrder.status).toBe(409);
      expect(crossOrder.body.error).toBe('IDEMPOTENCY_KEY_CONFLICT');

      // Same key on refund for same order returns 409 IDEMPOTENCY_KEY_CONFLICT.
      const crossKind = await request(app)
        .post(`/api/orders/${idA}/refunds`)
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', 'pay-idem-1')
        .send({ amount: 100, method: 'CASH' });
      expect(crossKind.status).toBe(409);
      expect(crossKind.body.error).toBe('IDEMPOTENCY_KEY_CONFLICT');

      // Concurrent same key on same order -> 201 + 200, single row inserted.
      const [same1, same2] = await Promise.all([
        request(app)
          .post(`/api/orders/${idB}/payments`)
          .set(as(OWNER_TOKEN))
          .set('Idempotency-Key', 'race-same-key')
          .send({ amount: 200, method: 'CASH' }),
        request(app)
          .post(`/api/orders/${idB}/payments`)
          .set(as(OWNER_TOKEN))
          .set('Idempotency-Key', 'race-same-key')
          .send({ amount: 200, method: 'CASH' }),
      ]);
      expect([same1.status, same2.status].sort()).toEqual([200, 201]);
      expect(await paymentRowsFor(idB)).toHaveLength(1);

      // Concurrent same key across two orders -> 201 + 409 IDEMPOTENCY_KEY_CONFLICT.
      const [diffA, diffB] = await Promise.all([
        request(app)
          .post(`/api/orders/${idA}/payments`)
          .set(as(OWNER_TOKEN))
          .set('Idempotency-Key', 'race-diff-key')
          .send({ amount: 100, method: 'CASH' }),
        request(app)
          .post(`/api/orders/${idB}/payments`)
          .set(as(OWNER_TOKEN))
          .set('Idempotency-Key', 'race-diff-key')
          .send({ amount: 100, method: 'CASH' }),
      ]);
      expect([diffA.status, diffB.status].sort()).toEqual([201, 409]);
      const diffConflict = diffA.status === 409 ? diffA : diffB;
      expect(diffConflict.body.error).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('restricts BKASH/NAGAD to BDT writes, keeps historical entries readable after currency switch, and checks paymentDate in business timezone', async () => {
      // Create order with BKASH while BIZ is BDT, then switch currency to USD.
      const bdtOrder = await createOrder(
        baseOrder({
          initialPayment: {
            amount: 500,
            method: 'BKASH',
            paymentDate: '2020-05-01', // past date before order creation is accepted
          },
        }),
      );
      expect(bdtOrder.status).toBe(201);
      expect(bdtOrder.body.data.payments[0].paymentDate).toBe('2020-05-01');

      await getDb().update(businesses).set({ currency: 'USD' }).where(eq(businesses.id, BIZ));

      // New BKASH and NAGAD writes fail with 400 naming method.
      const blockedBkash = await request(app)
        .post(`/api/orders/${bdtOrder.body.data.id}/payments`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 100, method: 'BKASH' });
      expect(blockedBkash.status).toBe(400);
      expect(blockedBkash.body.fields).toContain('method');

      const blockedNagad = await request(app)
        .post(`/api/orders/${bdtOrder.body.data.id}/payments`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 100, method: 'NAGAD' });
      expect(blockedNagad.status).toBe(400);
      expect(blockedNagad.body.fields).toContain('method');

      // Existing BKASH entry remains readable on detail and filterable on /api/payments.
      const detail = await request(app)
        .get(`/api/orders/${bdtOrder.body.data.id}`)
        .set(as(OWNER_TOKEN));
      expect(detail.status).toBe(200);
      expect(detail.body.data.payments[0].method).toBe('BKASH');

      const ledger = await request(app)
        .get('/api/payments?from=2020-05-01&to=2020-05-31&method=BKASH')
        .set(as(OWNER_TOKEN));
      expect(ledger.status).toBe(200);
      expect(ledger.body.data.items).toHaveLength(1);

      // Future date in non-Dhaka business timezone (America/New_York) rejected with 400 naming paymentDate.
      const usdOrder = await createOrder(
        {
          customerId: fixtures.usdCustomerId,
          items: [{ productId: fixtures.usdProductId, quantity: 1 }],
          source: 'DIRECT',
        },
        { businessId: USD_BIZ },
      );
      const tomorrowNy = shiftIsoDate(todayInTimeZone('America/New_York'), 1);
      const futurePay = await request(app)
        .post(`/api/orders/${usdOrder.body.data.id}/payments`)
        .set(as(OWNER_TOKEN, USD_BIZ))
        .send({ amount: 50, method: 'CARD', paymentDate: tomorrowNy });
      expect(futurePay.status).toBe(400);
      expect(futurePay.body.fields).toContain('paymentDate');
    });

    it('rolls back create-with-payment, record payment, refund, and void when audit_logs insert fails', async () => {
      const orderRes = await createOrder(
        baseOrder({ initialPayment: { amount: 400, method: 'CASH' } }),
      );
      const orderId = orderRes.body.data.id as string;
      const existingPayId = orderRes.body.data.payments[0].id as string;

      await installFailingAuditTrigger();
      try {
        // 1. Create with initialPayment rolls back completely.
        const ordersBefore = (await getDb().select().from(orders)).length;
        const paymentsBefore = (await getDb().select().from(payments)).length;

        const failedCreate = await createOrder(
          baseOrder({ initialPayment: { amount: 500, method: 'CASH' } }),
        );
        expect(failedCreate.status).toBe(500);
        expect((await getDb().select().from(orders)).length).toBe(ordersBefore);
        expect((await getDb().select().from(payments)).length).toBe(paymentsBefore);

        // 2. Record payment rolls back.
        const failedPay = await request(app)
          .post(`/api/orders/${orderId}/payments`)
          .set(as(OWNER_TOKEN))
          .send({ amount: 200, method: 'CASH' });
        expect(failedPay.status).toBe(500);

        // 3. Record refund rolls back.
        const failedRefund = await request(app)
          .post(`/api/orders/${orderId}/refunds`)
          .set(as(OWNER_TOKEN))
          .send({ amount: 200, method: 'CASH' });
        expect(failedRefund.status).toBe(500);

        // 4. Void rolls back.
        const failedVoid = await request(app)
          .post(`/api/orders/${orderId}/payments/${existingPayId}/void`)
          .set(as(OWNER_TOKEN))
          .send({ reason: 'Must roll back' });
        expect(failedVoid.status).toBe(500);
      } finally {
        await removeFailingAuditTrigger();
      }

      const intact = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(intact.body.data).toMatchObject({ paidAmount: 400, dueAmount: 600 });
      expect(intact.body.data.payments).toHaveLength(1);
      expect(intact.body.data.payments[0].voidedAt).toBeNull();
    });

    it('enforces tenant isolation and returns live DB role on GET /api/business/me', async () => {
      const created = await createOrder(
        baseOrder({ initialPayment: { amount: 300, method: 'CASH' } }),
      );
      const orderId = created.body.data.id as string;
      const paymentId = created.body.data.payments[0].id as string;

      // Outsider in OTHER_BIZ cannot pay, refund, void, or see BIZ ledger rows.
      const crossPay = await request(app)
        .post(`/api/orders/${orderId}/payments`)
        .set(as(OUTSIDER_TOKEN, OTHER_BIZ))
        .send({ amount: 100, method: 'CASH' });
      expect(crossPay.status).toBe(404);

      const crossVoid = await request(app)
        .post(`/api/orders/${orderId}/payments/${paymentId}/void`)
        .set(as(OUTSIDER_TOKEN, OTHER_BIZ))
        .send({ reason: 'Cross tenant' });
      expect(crossVoid.status).toBe(404);

      const otherLedger = await request(app)
        .get('/api/payments?from=2020-01-01&to=2020-12-31')
        .set(as(OUTSIDER_TOKEN, OTHER_BIZ));
      expect(otherLedger.status).toBe(200);
      expect(otherLedger.body.data.items).toEqual([]);

      // Demote OWNER in DB to STAFF while JWT still says OWNER; GET /api/business/me returns live STAFF role.
      const meBefore = await request(app).get('/api/business/me').set(as(OWNER_TOKEN));
      expect(meBefore.status).toBe(200);
      expect(meBefore.body.data.role).toBe('OWNER');

      await getDb()
        .update(businessMembers)
        .set({ role: 'STAFF' })
        .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, OWNER)));

      const meAfter = await request(app).get('/api/business/me').set(as(OWNER_TOKEN));
      expect(meAfter.status).toBe(200);
      expect(meAfter.body.data.role).toBe('STAFF');

      // And refund now returns 403 even with the stale OWNER JWT.
      const blockedRefund = await request(app)
        .post(`/api/orders/${orderId}/refunds`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 100, method: 'CASH' });
      expect(blockedRefund.status).toBe(403);
    });
  });

  describe('GET /api/payments ledger (AC-17)', () => {
    it('validates date ranges (leap year 366 ok, 367 rejected), computes summary excluding voids, and binds cursors', async () => {
      // Leap year 2024: 366 days inclusive passes; 367 days fails.
      const leapOk = await request(app)
        .get('/api/payments?from=2024-01-01&to=2024-12-31')
        .set(as(OWNER_TOKEN));
      expect(leapOk.status).toBe(200);

      const tooWide = await request(app)
        .get('/api/payments?from=2024-01-01&to=2025-01-01')
        .set(as(OWNER_TOKEN));
      expect(tooWide.status).toBe(400);
      expect(tooWide.body.fields).toEqual(expect.arrayContaining(['from', 'to']));

      const reversed = await request(app)
        .get('/api/payments?from=2026-05-10&to=2026-05-01')
        .set(as(OWNER_TOKEN));
      expect(reversed.status).toBe(400);
      expect(reversed.body.fields).toEqual(expect.arrayContaining(['from', 'to']));

      // Future filter dates are allowed.
      const futureRange = await request(app)
        .get('/api/payments?from=2099-01-01&to=2099-01-31')
        .set(as(OWNER_TOKEN));
      expect(futureRange.status).toBe(200);
      expect(futureRange.body.data.items).toEqual([]);

      // Seed 3 entries on one order: live payment 700, live refund 200, voided payment 300.
      const order = await createOrder(
        baseOrder({
          initialPayment: { amount: 700, method: 'BKASH', paymentDate: '2026-03-10' },
        }),
      );
      const orderId = order.body.data.id as string;

      const payToVoid = await request(app)
        .post(`/api/orders/${orderId}/payments`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 300, method: 'CASH', paymentDate: '2026-03-11' });
      const voidPayId = payToVoid.body.data.payments[1].id as string;

      await request(app)
        .post(`/api/orders/${orderId}/payments/${voidPayId}/void`)
        .set(as(OWNER_TOKEN))
        .send({ reason: 'Entered twice' });

      await request(app)
        .post(`/api/orders/${orderId}/refunds`)
        .set(as(OWNER_TOKEN))
        .send({ amount: 200, method: 'BKASH', paymentDate: '2026-03-12' });

      // Full ledger shows all 3 rows newest-first, summary excludes voided 300.
      const all = await request(app)
        .get('/api/payments?from=2026-03-01&to=2026-03-31')
        .set(as(STAFF_TOKEN));
      expect(all.status).toBe(200);
      expect(all.body.data.items).toHaveLength(3);
      expect(all.body.data.items[0]).toMatchObject({
        orderNumber: order.body.data.orderNumber,
        customerName: 'Nusrat Jahan',
        kind: 'REFUND',
        amount: 200,
        paymentDate: '2026-03-12',
      });
      expect(all.body.data.summary).toEqual({
        collected: 700,
        refunded: 200,
        net: 500,
      });

      // kind=REFUND yields negative net.
      const refundsOnly = await request(app)
        .get('/api/payments?from=2026-03-01&to=2026-03-31&kind=REFUND')
        .set(as(OWNER_TOKEN));
      expect(refundsOnly.status).toBe(200);
      expect(refundsOnly.body.data.summary).toEqual({
        collected: 0,
        refunded: 200,
        net: -200,
      });

      // Cursor pagination and mismatch rejection.
      const p1 = await request(app)
        .get('/api/payments?from=2026-03-01&to=2026-03-31&limit=2')
        .set(as(OWNER_TOKEN));
      expect(p1.status).toBe(200);
      expect(p1.body.data.items).toHaveLength(2);
      expect(p1.body.data.nextCursor).toBeTruthy();

      const p2 = await request(app)
        .get(
          `/api/payments?from=2026-03-01&to=2026-03-31&limit=2&cursor=${encodeURIComponent(p1.body.data.nextCursor)}`,
        )
        .set(as(OWNER_TOKEN));
      expect(p2.status).toBe(200);
      expect(p2.body.data.items).toHaveLength(1);
      expect(p2.body.data.nextCursor).toBeNull();

      const badCursor = await request(app)
        .get(
          `/api/payments?from=2026-03-01&to=2026-03-31&kind=PAYMENT&limit=2&cursor=${encodeURIComponent(p1.body.data.nextCursor)}`,
        )
        .set(as(OWNER_TOKEN));
      expect(badCursor.status).toBe(400);
      expect(badCursor.body.fields).toContain('cursor');

      // Default from/to uses the owning business's current month (America/New_York).
      const todayNy = todayInTimeZone('America/New_York');
      const prevMonthDay = shiftIsoDate(`${todayNy.slice(0, 7)}-01`, -1);
      await createOrder(
        {
          customerId: fixtures.usdCustomerId,
          items: [{ productId: fixtures.usdProductId, quantity: 1 }],
          source: 'DIRECT',
          confirmDuplicate: true,
          initialPayment: { amount: 40, method: 'CARD', paymentDate: todayNy },
        },
        { businessId: USD_BIZ },
      );
      await createOrder(
        {
          customerId: fixtures.usdCustomerId,
          items: [{ productId: fixtures.usdProductId, quantity: 1 }],
          source: 'DIRECT',
          confirmDuplicate: true,
          initialPayment: { amount: 60, method: 'CARD', paymentDate: prevMonthDay },
        },
        { businessId: USD_BIZ },
      );

      const defaultNy = await request(app).get('/api/payments').set(as(OWNER_TOKEN, USD_BIZ));
      expect(defaultNy.status).toBe(200);
      expect(defaultNy.body.data.items).toHaveLength(1);
      expect(defaultNy.body.data.items[0].amount).toBe(40);
      expect(defaultNy.body.data.summary).toEqual({ collected: 40, refunded: 0, net: 40 });
    });
  });

  describe('3-step payment migration backfill (AC-22)', () => {
    it('backfills legacy payments across timezones with corrupt-TZ fallback, recomputes order balances, and enforces checks', async () => {
      const scratchName = `fcommerce_pay_mig_${Date.now()}`;
      const { adminUrl, targetUrl } = migrationScratchUrl(scratchName);
      const admin = new Pool({ connectionString: adminUrl });
      await admin.query(`CREATE DATABASE "${scratchName}"`);

      const scratch = new Pool({ connectionString: targetUrl });
      try {
        const journalRaw = await fs.readFile(
          path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'),
          'utf8',
        );
        const journal = JSON.parse(journalRaw) as { entries: { idx: number; tag: string }[] };
        const preFiles = journal.entries
          .filter((entry) => entry.idx <= 8)
          .map((entry) => `${entry.tag}.sql`);
        const postFiles = journal.entries
          .filter((entry) => entry.idx >= 9 && entry.idx <= 11)
          .map((entry) => `${entry.tag}.sql`);

        await runMigrationFiles(scratch, preFiles);

        // Seed two businesses: New York and a corrupt timezone (Mars/Olympus -> fallback Asia/Dhaka).
        const bizNy = '00000000-0000-0000-0000-000000009001';
        const bizCorrupt = '00000000-0000-0000-0000-000000009002';
        await scratch.query(
          `INSERT INTO businesses (id, name, currency, timezone) VALUES
            ($1, 'NY Legacy', 'USD', 'America/New_York'),
            ($2, 'Corrupt TZ Legacy', 'BDT', 'Mars/Olympus')`,
          [bizNy, bizCorrupt],
        );

        const ordActive = '00000000-0000-0000-0000-000000009101';
        const ordCancelled = '00000000-0000-0000-0000-000000009102';
        await scratch.query(
          `INSERT INTO orders (id, business_id, order_number, status, source, customer_name_snapshot, customer_phone_snapshot, subtotal, total, paid_amount, due_amount) VALUES
            ($1, $3, 'ORD-0001', 'PENDING', 'DIRECT', 'Buyer A', '+12125550001', 1000, 1000, 0, 1000),
            ($2, $4, 'ORD-0002', 'CANCELLED', 'DIRECT', 'Buyer B', '+8801700000001', 800, 800, 0, 800)`,
          [ordActive, ordCancelled, bizNy, bizCorrupt],
        );

        // 2026-10-25T02:00:00Z is 2026-10-24 in America/New_York.
        // 2026-10-25T20:00:00Z is 2026-10-26 in Asia/Dhaka (fallback for Mars/Olympus).
        await scratch.query(
          `INSERT INTO payments (business_id, order_id, amount, method, payment_date) VALUES
            ($1, $2, 350, 'CARD', '2026-10-25T02:00:00Z'::timestamptz),
            ($3, $4, 250, 'BKASH', '2026-10-25T20:00:00Z'::timestamptz)`,
          [bizNy, ordActive, bizCorrupt, ordCancelled],
        );

        await runMigrationFiles(scratch, postFiles);

        const migratedPayments = await scratch.query<{
          order_id: string;
          kind: string;
          payment_date: string;
          recorded_by_user_id: string;
          recorded_by_name: string;
        }>(
          `SELECT order_id, kind, to_char(payment_date, 'YYYY-MM-DD') AS payment_date, recorded_by_user_id, recorded_by_name
           FROM payments ORDER BY amount DESC`,
        );
        expect(migratedPayments.rows).toEqual([
          {
            order_id: ordActive,
            kind: 'PAYMENT',
            payment_date: '2026-10-24',
            recorded_by_user_id: '00000000-0000-0000-0000-000000000000',
            recorded_by_name: 'Legacy record',
          },
          {
            order_id: ordCancelled,
            kind: 'PAYMENT',
            payment_date: '2026-10-26',
            recorded_by_user_id: '00000000-0000-0000-0000-000000000000',
            recorded_by_name: 'Legacy record',
          },
        ]);

        const migratedOrders = await scratch.query<{
          id: string;
          paid_amount: number;
          due_amount: number;
        }>(`SELECT id, paid_amount, due_amount FROM orders ORDER BY order_number ASC`);
        expect(migratedOrders.rows).toEqual([
          { id: ordActive, paid_amount: 350, due_amount: 650 },
          { id: ordCancelled, paid_amount: 250, due_amount: 0 },
        ]);

        // Verify CHECK constraints actively guard invalid inserts.
        await expect(
          scratch.query(
            `INSERT INTO payments (business_id, order_id, kind, amount, method, payment_date, recorded_by_user_id, recorded_by_name)
             VALUES ($1, $2, 'PAYMENT', 0, 'CASH', '2026-10-24', '00000000-0000-0000-0000-000000000000', 'Test')`,
            [bizNy, ordActive],
          ),
        ).rejects.toThrow(/payments_amount_positive/);

        await expect(
          scratch.query(`UPDATE orders SET paid_amount = 1200 WHERE id = $1`, [ordActive]),
        ).rejects.toThrow(/orders_paid_within_total/);
      } finally {
        await scratch.end();
        await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
        await admin.end();
      }
    }, 30_000);
  });
});
