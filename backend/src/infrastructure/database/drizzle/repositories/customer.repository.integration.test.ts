import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DrizzleCustomerRepository } from './customer.repository.js';
import { getDb } from '../client.js';
import {
  startPg,
  stopPg,
  resetDatabase,
  seedMembership,
} from '../../../../test-support/pg-test-database.js';
import { runWithContext } from '../context.js';
import { OrderStatus } from '../../../../domain/entities/order.entity.js';
import { businesses, customers, orders, auditLogs } from '../schema.js';
import { and, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

const BIZ_A = '00000000-0000-0000-0000-00000000000a';
const BIZ_B = '00000000-0000-0000-0000-00000000000b';
const USER = '00000000-0000-0000-0000-000000000001';

const AUDIT_ARCHIVE = {
  businessId: BIZ_A,
  userId: USER,
  action: 'CUSTOMER_ARCHIVED',
  entityType: 'CUSTOMER',
  entityId: '',
};

let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+88017${String(phoneSeq).padStart(8, '0')}`;
}

function inBusiness<T>(businessId: string, fn: () => Promise<T> | T): Promise<T> {
  return runWithContext({ userId: USER, businessId, role: 'OWNER' }, async () => await fn());
}

async function auditCount(filter: { entityId?: string; action?: string }): Promise<number> {
  return inBusiness(BIZ_A, async () => {
    const db = getDb();
    const conditions: SQL[] = [eq(auditLogs.businessId, BIZ_A)];
    if (filter.entityId !== undefined) conditions.push(eq(auditLogs.entityId, filter.entityId));
    if (filter.action !== undefined) conditions.push(eq(auditLogs.action, filter.action));
    const result = await db
      .select({ count: sql`count(*)` })
      .from(auditLogs)
      .where(and(...conditions));
    return Number(result[0]?.count ?? 0);
  });
}

/** Insert the tenant row every scoped entity references. */
async function seedBusiness(businessId: string): Promise<void> {
  await getDb()
    .insert(businesses)
    .values({ id: businessId, name: `Business ${businessId}` });
}

async function seedCustomer(
  businessId: string,
  name: string,
  extra: { phone?: string; archivedAt?: Date } = {},
): Promise<string> {
  return inBusiness(businessId, async () => {
    const db = getDb();
    const result = await db
      .insert(customers)
      .values({
        businessId,
        name,
        phone: extra.phone ?? nextPhone(),
        archivedAt: extra.archivedAt ?? null,
        version: 1,
      })
      .returning({ id: customers.id });
    if (result.length === 0) throw new Error('Failed to seed customer');
    return result[0].id;
  });
}

async function seedOrder(
  businessId: string,
  customerId: string,
  fields: {
    orderNumber: string;
    total: number;
    dueAmount: number;
    status?: OrderStatus;
    createdAt?: Date;
  },
): Promise<string> {
  return inBusiness(businessId, async () => {
    const db = getDb();
    const result = await db
      .insert(orders)
      .values({
        businessId,
        customerId,
        orderNumber: fields.orderNumber,
        status: fields.status ?? OrderStatus.PENDING,
        customerNameSnapshot: 'Snapshot customer',
        customerPhoneSnapshot: '+8801700000000',
        subtotal: fields.total,
        deliveryFee: 0,
        discount: 0,
        total: fields.total,
        paidAmount: fields.total - fields.dueAmount,
        dueAmount: fields.dueAmount,
      })
      .returning({ id: orders.id });
    const orderId = result[0].id;
    if (fields.createdAt) {
      await db.update(orders).set({ createdAt: fields.createdAt }).where(eq(orders.id, orderId));
    }
    return orderId;
  });
}

describe('DrizzleCustomerRepository', () => {
  beforeAll(async () => {
    await startPg();
  }, 30_000);

  afterAll(async () => {
    await stopPg();
  }, 30_000);

  beforeEach(async () => {
    await resetDatabase();
    await seedBusiness(BIZ_A);
    await seedMembership(BIZ_A, USER, 'OWNER');
    await seedBusiness(BIZ_B);
  });

  const repo = new DrizzleCustomerRepository();

  describe('tenant isolation (AC-11)', () => {
    it('does not return a customer that belongs to another business', async () => {
      const id = await seedCustomer(BIZ_A, 'Rahim');
      const found = await inBusiness(BIZ_B, () => repo.findById(id));
      expect(found).toBeNull();
    });
  });

  describe('phone uniqueness (AC-2, AC-3)', () => {
    it('rejects a second customer with the same phone in one business', async () => {
      const phone = '+8801712345678';
      await seedCustomer(BIZ_A, 'Rahim', { phone });

      await expect(seedCustomer(BIZ_A, 'Karim', { phone })).rejects.toMatchObject({
        cause: { code: '23505' },
      });
    });

    it('allows the same phone in a different business', async () => {
      const phone = '+8801712345678';
      await seedCustomer(BIZ_A, 'Rahim', { phone });
      await expect(seedCustomer(BIZ_B, 'Karim', { phone })).resolves.toEqual(expect.any(String));
    });
  });

  describe('archive and restore transactions (AC-8, AC-10)', () => {
    it('commits the archive and exactly one audit entry together', async () => {
      const id = await seedCustomer(BIZ_A, 'Rahim');

      const updated = await inBusiness(BIZ_A, () =>
        repo.archiveWithAudit(id, 1, { ...AUDIT_ARCHIVE, entityId: id }),
      );

      expect(updated?.version).toBe(2);
      expect(updated?.archivedAt).toBeInstanceOf(Date);
      expect(await auditCount({ entityId: id })).toBe(1);
    });

    it('rolls back the archive when the audit insert fails', async () => {
      const id = await seedCustomer(BIZ_A, 'Rahim');

      // An invalid user id makes the audit insert fail inside the transaction.
      await expect(
        inBusiness(BIZ_A, () =>
          repo.archiveWithAudit(id, 1, {
            ...AUDIT_ARCHIVE,
            entityId: id,
            userId: 'not-a-uuid',
          }),
        ),
      ).rejects.toThrow();

      const stored = await inBusiness(BIZ_A, () => repo.findById(id));
      expect(stored?.archivedAt).toBeUndefined();
      expect(stored?.version).toBe(1);
      expect(await auditCount({ entityId: id })).toBe(0);
    });

    it('restores an archived customer, clears archivedAt, and writes one audit entry', async () => {
      const id = await seedCustomer(BIZ_A, 'Rahim', { archivedAt: new Date() });

      const restored = await inBusiness(BIZ_A, () =>
        repo.restoreWithAudit(id, 1, {
          ...AUDIT_ARCHIVE,
          action: 'CUSTOMER_RESTORED',
          entityId: id,
        }),
      );

      expect(restored?.archivedAt).toBeUndefined();
      expect(restored?.version).toBe(2);
      expect(await auditCount({ entityId: id, action: 'CUSTOMER_RESTORED' })).toBe(1);
    });
  });

  describe('version guard on edits (AC-4)', () => {
    it('changes nothing when the version is stale', async () => {
      const id = await seedCustomer(BIZ_A, 'Rahim');

      const result = await inBusiness(BIZ_A, () => repo.update(id, 2, { name: 'Karim' }, 3));
      expect(result).toBeNull();
      const stored = await inBusiness(BIZ_A, () => repo.findById(id));
      expect(stored?.name).toBe('Rahim');
      expect(stored?.version).toBe(1);
    });

    it('raises the version by exactly one on a matching write', async () => {
      const id = await seedCustomer(BIZ_A, 'Rahim');

      const result = await inBusiness(BIZ_A, () => repo.update(id, 1, { name: 'Karim' }, 2));
      expect(result?.name).toBe('Karim');
      expect(result?.version).toBe(2);
    });

    it('clears an optional field when the change is null', async () => {
      const id = await seedCustomer(BIZ_A, 'Rahim');
      await inBusiness(BIZ_A, () => repo.update(id, 1, { email: 'rahim@example.com' }, 2));

      const result = await inBusiness(BIZ_A, () => repo.update(id, 2, { email: null }, 3));
      expect(result?.email).toBeUndefined();
      expect(result?.version).toBe(3);
    });
  });

  describe('search (AC-5)', () => {
    it('matches names by prefix ignoring case, skips archived customers, and sorts by name', async () => {
      await seedCustomer(BIZ_A, 'Anika');
      await seedCustomer(BIZ_A, 'anwar');
      await seedCustomer(BIZ_A, 'Babul');
      await seedCustomer(BIZ_A, 'Ananya');
      await seedCustomer(BIZ_A, 'Ali', { archivedAt: new Date() });

      const page = await inBusiness(BIZ_A, () =>
        repo.search({ nameQuery: 'a', phonePrefix: null, limit: 10 }),
      );

      expect(page.items.map((item) => item.name)).toEqual(['Ananya', 'Anika', 'anwar']);
      expect(page.hasMore).toBe(false);
    });

    it('matches phone prefixes and skips archived customers', async () => {
      await seedCustomer(BIZ_A, 'Anika', { phone: '+8801700000001' });
      await seedCustomer(BIZ_A, 'Babul', { phone: '+8801700000002' });
      await seedCustomer(BIZ_A, 'Chadni', { phone: '+8801900000003' });
      await seedCustomer(BIZ_A, 'Dilip', {
        phone: '+8801700000004',
        archivedAt: new Date(),
      });

      const page = await inBusiness(BIZ_A, () =>
        repo.search({ nameQuery: '', phonePrefix: '+880170', limit: 10 }),
      );

      expect(page.items.map((item) => item.name)).toEqual(['Anika', 'Babul']);
    });

    it('pages from a name and id anchor and reports hasMore', async () => {
      await seedCustomer(BIZ_A, 'Anika');
      await seedCustomer(BIZ_A, 'Babul');
      await seedCustomer(BIZ_A, 'Chadni');

      const first = await inBusiness(BIZ_A, () =>
        repo.search({ nameQuery: '', phonePrefix: null, limit: 2 }),
      );
      expect(first.items.map((item) => item.name)).toEqual(['Anika', 'Babul']);
      expect(first.hasMore).toBe(true);

      const last = first.items[first.items.length - 1];
      const second = await inBusiness(BIZ_A, () =>
        repo.search({
          nameQuery: '',
          phonePrefix: null,
          limit: 2,
          name: last.name,
          id: last.id,
        }),
      );
      expect(second.items.map((item) => item.name)).toEqual(['Chadni']);
      expect(second.hasMore).toBe(false);
    });
  });

  describe('order history and spend (AC-6, AC-7, AC-12)', () => {
    it('lists orders newest first and pages from a createdAt and id anchor', async () => {
      const customerId = await seedCustomer(BIZ_A, 'Rahim');
      const oldest = await seedOrder(BIZ_A, customerId, {
        orderNumber: 'ORD-1',
        total: 100,
        dueAmount: 100,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const middle = await seedOrder(BIZ_A, customerId, {
        orderNumber: 'ORD-2',
        total: 200,
        dueAmount: 0,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      });
      const newest = await seedOrder(BIZ_A, customerId, {
        orderNumber: 'ORD-3',
        total: 300,
        dueAmount: 300,
        createdAt: new Date('2026-03-01T00:00:00Z'),
      });

      const first = await inBusiness(BIZ_A, () => repo.listOrders({ customerId, limit: 2 }));
      expect(first.items.map((order) => order.id)).toEqual([newest, middle]);
      expect(first.hasMore).toBe(true);

      const last = first.items[first.items.length - 1];
      const second = await inBusiness(BIZ_A, () =>
        repo.listOrders({ customerId, limit: 2, createdAt: last.createdAt, id: last.id }),
      );
      expect(second.items.map((order) => order.id)).toEqual([oldest]);
      expect(second.hasMore).toBe(false);
    });

    it('excludes cancelled and returned orders from spend totals', async () => {
      const customerId = await seedCustomer(BIZ_A, 'Rahim');
      await seedOrder(BIZ_A, customerId, { orderNumber: 'ORD-1', total: 500, dueAmount: 100 });
      await seedOrder(BIZ_A, customerId, { orderNumber: 'ORD-2', total: 300, dueAmount: 300 });
      await seedOrder(BIZ_A, customerId, {
        orderNumber: 'ORD-3',
        total: 200,
        dueAmount: 200,
        status: OrderStatus.CANCELLED,
      });
      await seedOrder(BIZ_A, customerId, {
        orderNumber: 'ORD-4',
        total: 400,
        dueAmount: 0,
        status: OrderStatus.RETURNED,
      });

      const spend = await inBusiness(BIZ_A, () =>
        repo.aggregateSpend(customerId, [OrderStatus.CANCELLED, OrderStatus.RETURNED]),
      );

      expect(spend).toEqual({ orderCount: 2, totalSpent: 800, totalDue: 400 });
    });

    it('keeps an order without a customerId out of history and totals', async () => {
      const customerId = await seedCustomer(BIZ_A, 'Rahim');
      await seedOrder(BIZ_A, customerId, { orderNumber: 'ORD-1', total: 250, dueAmount: 50 });
      const db = getDb();
      await db.insert(orders).values({
        businessId: BIZ_A,
        orderNumber: 'LEGACY-1',
        status: OrderStatus.DELIVERED,
        customerNameSnapshot: 'Unknown customer',
        customerPhoneSnapshot: '',
        subtotal: 999,
        deliveryFee: 0,
        discount: 0,
        total: 999,
        paidAmount: 0,
        dueAmount: 999,
      });

      const history = await inBusiness(BIZ_A, () => repo.listOrders({ customerId, limit: 20 }));
      const spend = await inBusiness(BIZ_A, () =>
        repo.aggregateSpend(customerId, [OrderStatus.CANCELLED, OrderStatus.RETURNED]),
      );

      expect(history.items.map((order) => order.orderNumber)).toEqual(['ORD-1']);
      expect(spend).toEqual({ orderCount: 1, totalSpent: 250, totalDue: 50 });
    });
  });
});
