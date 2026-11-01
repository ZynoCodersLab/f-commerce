import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { eq, and, sql } from 'drizzle-orm';
import { customerRouter } from './customer.controller.js';
import { config } from '../../infrastructure/config.js';
import { getDb } from '../../infrastructure/database/drizzle/client.js';
import { runWithContext } from '../../infrastructure/database/drizzle/context.js';
import {
  businesses,
  customers,
  orders,
  auditLogs,
} from '../../infrastructure/database/drizzle/schema.js';
import { OrderStatus } from '../../domain/entities/order.entity.js';
import {
  startPg,
  stopPg,
  resetDatabase,
  seedMembership,
} from '../../test-support/pg-test-database.js';

const app = express();
app.use(express.json());
app.use('/api/customers', customerRouter);

const BIZ = '00000000-0000-0000-0000-0000000000a1';
const OTHER_BIZ = '00000000-0000-0000-0000-0000000000b2';
const OWNER = '00000000-0000-0000-0000-0000000000c3';
const STAFF = '00000000-0000-0000-0000-0000000000d4';
const OUTSIDER = '00000000-0000-0000-0000-0000000000e5';

function tokenFor(
  userId: string,
  memberships: { businessId: string; role: 'OWNER' | 'STAFF' }[],
): string {
  return jwt.sign({ userId, memberships }, config.JWT_SECRET);
}

const OWNER_TOKEN = tokenFor(OWNER, [{ businessId: BIZ, role: 'OWNER' }]);
const STAFF_TOKEN = tokenFor(STAFF, [{ businessId: BIZ, role: 'STAFF' }]);
const OUTSIDER_TOKEN = tokenFor(OUTSIDER, [{ businessId: OTHER_BIZ, role: 'OWNER' }]);

/** The audit table only accepts UUID user ids, so this actor cannot be recorded. */
const BROKEN_AUDIT_TOKEN = tokenFor('not-a-uuid', [{ businessId: BIZ, role: 'OWNER' }]);

function as(token: string, businessId = BIZ) {
  return { authorization: `Bearer ${token}`, 'x-business-id': businessId };
}

let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+88019${String(phoneSeq).padStart(8, '0')}`;
}

async function createViaApi(body: Record<string, unknown>, token = OWNER_TOKEN) {
  return request(app)
    .post('/api/customers')
    .set(as(token))
    .send({ phone: nextPhone(), ...body });
}

function inBiz<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ userId: OWNER, businessId, role: 'OWNER' }, async () => await fn());
}

/** Insert the tenant row every scoped entity references. */
async function seedBusiness(businessId: string): Promise<void> {
  await getDb()
    .insert(businesses)
    .values({ id: businessId, name: `Business ${businessId}` });
}

async function seedOrder(
  customerId: string,
  fields: {
    orderNumber: string;
    total: number;
    dueAmount: number;
    status?: OrderStatus;
    createdAt?: Date;
  },
): Promise<void> {
  await inBiz(BIZ, async () => {
    const db = getDb();
    const result = await db
      .insert(orders)
      .values({
        businessId: BIZ,
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
    if (fields.createdAt) {
      await db
        .update(orders)
        .set({ createdAt: fields.createdAt })
        .where(eq(orders.id, result[0].id));
    }
  });
}

async function countCustomers(where: Parameters<typeof and>[number]): Promise<number> {
  return inBiz(BIZ, async () => {
    const result = await getDb()
      .select({ count: sql`count(*)` })
      .from(customers)
      .where(and(eq(customers.businessId, BIZ), where));
    return Number(result[0]?.count ?? 0);
  });
}

async function findCustomer(id: string): Promise<typeof customers.$inferSelect | undefined> {
  return inBiz(BIZ, async () => {
    const result = await getDb().select().from(customers).where(eq(customers.id, id));
    return result[0];
  });
}

async function auditCount(entityId: string, action?: string): Promise<number> {
  return inBiz(BIZ, async () => {
    const conditions = [eq(auditLogs.businessId, BIZ), eq(auditLogs.entityId, entityId)];
    if (action !== undefined) conditions.push(eq(auditLogs.action, action));
    const result = await getDb()
      .select({ count: sql`count(*)` })
      .from(auditLogs)
      .where(and(...conditions));
    return Number(result[0]?.count ?? 0);
  });
}

describe('customer routes against PostgreSQL', () => {
  beforeAll(async () => {
    await startPg();
  }, 60_000);

  afterAll(async () => {
    await stopPg();
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase();
    await seedBusiness(BIZ);
    await seedBusiness(OTHER_BIZ);
    await seedMembership(BIZ, OWNER, 'OWNER');
    await seedMembership(BIZ, STAFF, 'STAFF');
  });

  describe('happy path (AC-1, AC-4, AC-5, AC-6, AC-7)', () => {
    it('creates, finds by name prefix, edits, and shows the profile with newest orders first', async () => {
      const created = await createViaApi({
        name: '  Anika Rahman  ',
        phone: '+880 17-1234 5678',
        email: 'anika@example.com',
      });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        name: 'Anika Rahman',
        phone: '+8801712345678',
        version: 1,
      });
      const id: string = created.body.data.id;

      const search = await request(app).get('/api/customers?q=ani').set(as(OWNER_TOKEN));
      expect(search.status).toBe(200);
      expect(search.body.data.items.map((item: { id: string }) => item.id)).toEqual([id]);

      const edited = await request(app)
        .patch(`/api/customers/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, address: 'Gulshan 2, Dhaka' });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ address: 'Gulshan 2, Dhaka', version: 2 });

      await seedOrder(id, {
        orderNumber: 'ORD-OLD',
        total: 300,
        dueAmount: 100,
        status: OrderStatus.DELIVERED,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      await seedOrder(id, {
        orderNumber: 'ORD-NEW',
        total: 500,
        dueAmount: 0,
        status: OrderStatus.CONFIRMED,
        createdAt: new Date('2026-03-01T00:00:00Z'),
      });
      await seedOrder(id, {
        orderNumber: 'ORD-CANCEL',
        total: 999,
        dueAmount: 999,
        status: OrderStatus.CANCELLED,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      });

      const profile = await request(app).get(`/api/customers/${id}`).set(as(OWNER_TOKEN));
      expect(profile.status).toBe(200);
      expect(profile.body.data).toMatchObject({
        id,
        phone: '+8801712345678',
        orderCount: 2,
        totalSpent: 800,
        totalDue: 100,
      });

      const orders = await request(app).get(`/api/customers/${id}/orders`).set(as(OWNER_TOKEN));
      expect(orders.status).toBe(200);
      expect(
        orders.body.data.items.map((order: { orderNumber: string }) => order.orderNumber),
      ).toEqual(['ORD-NEW', 'ORD-CANCEL', 'ORD-OLD']);
    });
  });

  describe('concurrency and version (AC-4)', () => {
    it('rejects the second of two edits sent with the same version', async () => {
      const created = await createViaApi({ name: 'Rahim' });
      const id: string = created.body.data.id;

      const first = await request(app)
        .patch(`/api/customers/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, name: 'Rahim Uddin' });
      const second = await request(app)
        .patch(`/api/customers/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, name: 'Rahim Khan' });

      expect(first.status).toBe(200);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('CUSTOMER_CHANGED');
      const stored = await findCustomer(id);
      expect(stored?.name).toBe('Rahim Uddin');
      expect(stored?.version).toBe(2);
    });

    it('returns the current customer without incrementing the version on a no-op edit', async () => {
      const created = await createViaApi({ name: 'Rahim' });
      const id: string = created.body.data.id;

      const response = await request(app)
        .patch(`/api/customers/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, name: 'Rahim' });

      expect(response.status).toBe(200);
      expect(response.body.data.version).toBe(1);
    });
  });

  describe('duplicate phone (AC-3)', () => {
    it('returns 409 DUPLICATE_PHONE with the existing id and archived flag, and saves nothing', async () => {
      const phone = '+8801711111111';
      const existing = await createViaApi({ name: 'Rahim', phone });
      const existingId: string = existing.body.data.id;

      const duplicate = await createViaApi({ name: 'Karim', phone: '+880 1711-111111' });

      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({
        error: 'DUPLICATE_PHONE',
        existingCustomerId: existingId,
        archived: false,
      });
      expect(await countCustomers(eq(customers.phone, phone))).toBe(1);
    });

    it('flags the duplicate as archived when the existing customer is archived', async () => {
      const phone = '+8801722222222';
      const existing = await createViaApi({ name: 'Rahim', phone });
      const existingId: string = existing.body.data.id;
      await request(app)
        .post(`/api/customers/${existingId}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });

      const duplicate = await createViaApi({ name: 'Karim', phone });

      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({
        error: 'DUPLICATE_PHONE',
        existingCustomerId: existingId,
        archived: true,
      });
    });
  });

  describe('validation (AC-1, AC-2)', () => {
    it('rejects a phone without a country code and saves nothing', async () => {
      const response = await createViaApi({ name: 'Rahim', phone: '01712345678' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR', fields: ['phone'] });
      expect(await countCustomers(sql`true`)).toBe(0);
    });

    it('accepts a phone written with Bengali digits and stores the ASCII form', async () => {
      const response = await createViaApi({ name: 'Rahim', phone: '+৮৮০১৭১২৩৪৫৬৭৮' });

      expect(response.status).toBe(201);
      expect(response.body.data.phone).toBe('+8801712345678');
    });

    it('rejects an empty name and names the field', async () => {
      const response = await createViaApi({ name: '   ' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR', fields: ['name'] });
    });

    it('rejects an invalid email and names the field', async () => {
      const response = await createViaApi({ name: 'Rahim', email: 'not-an-email' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR', fields: ['email'] });
    });

    it('trims padded optional fields on create and edit', async () => {
      const created = await createViaApi({
        name: '  Anika Rahman  ',
        email: '  anika@example.com  ',
        address: '  12 Lake Road  ',
        notes: '  Called ahead  ',
      });

      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        name: 'Anika Rahman',
        email: 'anika@example.com',
        address: '12 Lake Road',
        notes: 'Called ahead',
      });

      const edited = await request(app)
        .patch(`/api/customers/${created.body.data.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          email: '  new@example.com  ',
          address: '  14 Lake Road  ',
          notes: '  Leave at the desk  ',
        });

      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({
        email: 'new@example.com',
        address: '14 Lake Road',
        notes: 'Leave at the desk',
      });
    });

    it('rejects a malformed search cursor with 400', async () => {
      const response = await request(app).get('/api/customers?cursor=***').set(as(OWNER_TOKEN));

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR', fields: ['cursor'] });
    });

    it('clamps an oversized limit instead of rejecting it', async () => {
      const response = await request(app).get('/api/customers?limit=500').set(as(OWNER_TOKEN));

      expect(response.status).toBe(200);
    });
  });

  describe('archive, restore, and audit (AC-8, AC-9, AC-10)', () => {
    it('blocks edits to an archived customer, restores it, and writes one audit entry per transition', async () => {
      const created = await createViaApi({ name: 'Rahim' });
      const id: string = created.body.data.id;

      const archived = await request(app)
        .post(`/api/customers/${id}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });
      expect(archived.status).toBe(200);
      expect(archived.body.data.archivedAt).not.toBeNull();

      const blocked = await request(app)
        .patch(`/api/customers/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2, name: 'Changed' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe('CUSTOMER_ARCHIVED');

      const restored = await request(app)
        .post(`/api/customers/${id}/restore`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2 });
      expect(restored.status).toBe(200);
      expect(restored.body.data.archivedAt).toBeNull();

      expect(await auditCount(id, 'CUSTOMER_ARCHIVED')).toBe(1);
      expect(await auditCount(id, 'CUSTOMER_RESTORED')).toBe(1);
    });

    it('returns 500 and commits neither the archive nor its audit entry when the audit write fails', async () => {
      const created = await createViaApi({ name: 'Rahim' });
      const id: string = created.body.data.id;

      // The audit row is written in the same transaction as the archive, so a
      // rejected actor id must leave the customer untouched.
      const response = await request(app)
        .post(`/api/customers/${id}/archive`)
        .set(as(BROKEN_AUDIT_TOKEN))
        .send({ version: 1 });

      expect(response.status).toBe(500);
      const stored = await findCustomer(id);
      expect(stored?.archivedAt).toBeNull();
      expect(stored?.version).toBe(1);
      expect(await auditCount(id)).toBe(0);
    });

    it('rejects restoring a customer that is not archived', async () => {
      const created = await createViaApi({ name: 'Rahim' });
      const id: string = created.body.data.id;

      const response = await request(app)
        .post(`/api/customers/${id}/restore`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('CUSTOMER_NOT_ARCHIVED');
    });
  });

  describe('roles, tenant isolation, and unknown ids (AC-11)', () => {
    it('lets STAFF create and archive', async () => {
      const created = await createViaApi({ name: 'Rahim' }, STAFF_TOKEN);
      expect(created.status).toBe(201);
      const id: string = created.body.data.id;

      const archived = await request(app)
        .post(`/api/customers/${id}/archive`)
        .set(as(STAFF_TOKEN))
        .send({ version: 1 });
      expect(archived.status).toBe(200);
    });

    it('returns 403 for a user with no membership in the business', async () => {
      const response = await request(app).get('/api/customers').set(as(OUTSIDER_TOKEN));

      expect(response.status).toBe(403);
    });

    it('returns 403 for a user whose membership is in another business', async () => {
      const response = await request(app)
        .post('/api/customers')
        .set(as(OUTSIDER_TOKEN, BIZ))
        .send({ name: 'Rahim', phone: nextPhone() });

      expect(response.status).toBe(403);
      expect(await countCustomers(sql`true`)).toBe(0);
    });

    it('returns 401 when no bearer token is sent', async () => {
      const response = await request(app).get('/api/customers').set({ 'x-business-id': BIZ });

      expect(response.status).toBe(401);
    });

    it('returns 404 for a customer id that belongs to another business', async () => {
      const otherId = await inBiz(OTHER_BIZ, async () => {
        const result = await getDb()
          .insert(customers)
          .values({
            businessId: OTHER_BIZ,
            name: 'Other',
            phone: nextPhone(),
            version: 1,
          })
          .returning({ id: customers.id });
        return result[0].id;
      });

      const profile = await request(app).get(`/api/customers/${otherId}`).set(as(OWNER_TOKEN));
      const orders = await request(app)
        .get(`/api/customers/${otherId}/orders`)
        .set(as(OWNER_TOKEN));

      expect(profile.status).toBe(404);
      expect(orders.status).toBe(404);
    });

    it('returns 404 for a malformed customer id rather than 400', async () => {
      const response = await request(app)
        .get('/api/customers/not-an-object-id')
        .set(as(OWNER_TOKEN));

      expect(response.status).toBe(404);
    });

    it('returns 404 for an unknown customer id on the archive route', async () => {
      const response = await request(app)
        .post('/api/customers/00000000-0000-0000-0000-00000000ffff/archive')
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });

      expect(response.status).toBe(404);
    });
  });
});
