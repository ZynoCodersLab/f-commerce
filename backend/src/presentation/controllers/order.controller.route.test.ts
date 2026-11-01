import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { and, eq, sql } from 'drizzle-orm';
import { orderRouter } from './order.controller.js';
import { config } from '../../infrastructure/config.js';
import { getDb } from '../../infrastructure/database/drizzle/client.js';
import {
  auditLogs,
  businessOrderCounters,
  businesses,
  categories,
  customers,
  orderItems,
  orderStatusHistory,
  orders,
  productVariants,
  products,
  users,
} from '../../infrastructure/database/drizzle/schema.js';
import {
  startPg,
  stopPg,
  resetDatabase,
  seedMembership,
} from '../../test-support/pg-test-database.js';
import { DrizzleOrderRepository } from '../../infrastructure/database/drizzle/repositories/order.repository.js';
import { runWithContext } from '../../infrastructure/database/drizzle/context.js';

const app = express();
app.use(express.json());
app.use('/api/orders', orderRouter);

const BIZ = '00000000-0000-0000-0000-0000000000a1';
const OTHER_BIZ = '00000000-0000-0000-0000-0000000000b2';
const OWNER = '00000000-0000-0000-0000-0000000000c3';
const STAFF = '00000000-0000-0000-0000-0000000000d4';
const OUTSIDER = '00000000-0000-0000-0000-0000000000e5';
const BROKEN_ACTOR = 'not-a-uuid';

function tokenFor(
  userId: string,
  memberships: { businessId: string; role: 'OWNER' | 'STAFF' }[],
): string {
  return jwt.sign({ userId, memberships }, config.JWT_SECRET);
}

const OWNER_TOKEN = tokenFor(OWNER, [{ businessId: BIZ, role: 'OWNER' }]);
const STAFF_TOKEN = tokenFor(STAFF, [{ businessId: BIZ, role: 'STAFF' }]);
const OUTSIDER_TOKEN = tokenFor(OUTSIDER, [{ businessId: OTHER_BIZ, role: 'OWNER' }]);
const BROKEN_TOKEN = tokenFor(BROKEN_ACTOR, [{ businessId: BIZ, role: 'OWNER' }]);
const NO_ACTOR_TOKEN = jwt.sign(
  { memberships: [{ businessId: BIZ, role: 'OWNER' }] },
  config.JWT_SECRET,
);

function as(token: string, businessId = BIZ) {
  return { authorization: `Bearer ${token}`, 'x-business-id': businessId };
}

let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+88019${String(phoneSeq).padStart(8, '0')}`;
}

interface Fixtures {
  categoryId: string;
  customerId: string;
  secondCustomerId: string;
  thirdCustomerId: string;
  otherCustomerId: string;
  simpleProductId: string;
  variantProductId: string;
  variantSId: string;
  variantMId: string;
  otherProductId: string;
}

let fixtures: Fixtures;

async function seedBusiness(businessId: string): Promise<void> {
  await getDb()
    .insert(businesses)
    .values({ id: businessId, name: `Business ${businessId}` });
}

async function seedUser(id: string, name: string): Promise<void> {
  await getDb()
    .insert(users)
    .values({ id, email: `${id}@example.com`, name });
}

async function seedCustomer(
  businessId: string,
  fields: { name: string; phone?: string; address?: string | null; archivedAt?: Date },
): Promise<string> {
  const rows = await getDb()
    .insert(customers)
    .values({
      businessId,
      name: fields.name,
      phone: fields.phone ?? nextPhone(),
      address: fields.address ?? null,
      archivedAt: fields.archivedAt ?? null,
    })
    .returning({ id: customers.id });
  return rows[0].id;
}

async function seedCategory(businessId: string, name: string): Promise<string> {
  const rows = await getDb()
    .insert(categories)
    .values({ businessId, name })
    .returning({ id: categories.id });
  return rows[0].id;
}

async function seedProduct(
  businessId: string,
  categoryId: string,
  fields: {
    name: string;
    price: number;
    cost?: number;
    isArchived?: boolean;
    options?: { name: string; values: string[] }[];
    variants?: { combination: Record<string, string>; price?: number; cost?: number }[];
  },
): Promise<{ id: string; variantIds: string[] }> {
  const rows = await getDb()
    .insert(products)
    .values({
      businessId,
      categoryId,
      name: fields.name,
      price: fields.price,
      cost: fields.cost ?? null,
      options: fields.options ?? [],
      isArchived: fields.isArchived ?? false,
      archivedAt: fields.isArchived ? new Date() : null,
    })
    .returning({ id: products.id });
  const productId = rows[0].id;

  const variantIds: string[] = [];
  for (const [position, variant] of (fields.variants ?? []).entries()) {
    const inserted = await getDb()
      .insert(productVariants)
      .values({
        businessId,
        productId,
        combination: variant.combination,
        price: variant.price ?? null,
        cost: variant.cost ?? null,
        position,
      })
      .returning({ id: productVariants.id });
    variantIds.push(inserted[0].id);
  }

  return { id: productId, variantIds };
}

async function seedFixtures(): Promise<void> {
  await seedBusiness(BIZ);
  await seedBusiness(OTHER_BIZ);
  await seedUser(OWNER, 'Maya Owner');
  await seedUser(STAFF, 'Sam Staff');
  await seedMembership(BIZ, OWNER, 'OWNER');
  await seedMembership(BIZ, STAFF, 'STAFF');
  await seedMembership(OTHER_BIZ, OUTSIDER, 'OWNER');

  const categoryId = await seedCategory(BIZ, 'Tops');
  const otherCategoryId = await seedCategory(OTHER_BIZ, 'Other tops');

  const customerId = await seedCustomer(BIZ, {
    name: 'Nusrat Jahan',
    phone: '+8801712345678',
    address: 'House 12, Road 5',
  });
  const secondCustomerId = await seedCustomer(BIZ, {
    name: 'Tanvir Ahmed',
    phone: '+8801812345678',
    address: 'Flat 3B, Gulshan',
  });
  const thirdCustomerId = await seedCustomer(BIZ, {
    name: 'Sadia Karim',
    phone: '+8801912345678',
  });
  const otherCustomerId = await seedCustomer(OTHER_BIZ, { name: 'Other Buyer' });

  const simple = await seedProduct(BIZ, categoryId, {
    name: 'Cotton shirt',
    price: 1000,
    cost: 600,
  });
  const variantProduct = await seedProduct(BIZ, categoryId, {
    name: 'Panjabi',
    price: 2000,
    cost: 1200,
    options: [{ name: 'Size', values: ['S', 'M'] }],
    variants: [
      { combination: { Size: 'S' }, price: 2500, cost: 1500 },
      { combination: { Size: 'M' }, price: 2800, cost: 1600 },
    ],
  });
  const other = await seedProduct(OTHER_BIZ, otherCategoryId, {
    name: 'Other product',
    price: 500,
  });

  fixtures = {
    categoryId,
    customerId,
    secondCustomerId,
    thirdCustomerId,
    otherCustomerId,
    simpleProductId: simple.id,
    variantProductId: variantProduct.id,
    variantSId: variantProduct.variantIds[0],
    variantMId: variantProduct.variantIds[1],
    otherProductId: other.id,
  };
}

function createOrder(
  body: Record<string, unknown>,
  token = OWNER_TOKEN,
  idempotencyKey?: string,
  businessId = BIZ,
) {
  const call = request(app).post('/api/orders').set(as(token, businessId));
  if (idempotencyKey !== undefined) call.set('Idempotency-Key', idempotencyKey);
  return call.send(body);
}

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    customerId: fixtures.customerId,
    items: [{ productId: fixtures.simpleProductId, quantity: 1 }],
    source: 'FACEBOOK',
    ...overrides,
  };
}

async function countOrders(): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(orders);
  return Number(rows[0]?.count ?? 0);
}

async function findOrder(id: string) {
  const rows = await getDb().select().from(orders).where(eq(orders.id, id));
  return rows[0];
}

async function historyFor(id: string) {
  return getDb()
    .select()
    .from(orderStatusHistory)
    .where(eq(orderStatusHistory.orderId, id))
    .orderBy(orderStatusHistory.createdAt);
}

async function auditRowsFor(id: string) {
  return getDb()
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.businessId, BIZ), eq(auditLogs.entityId, id)));
}

describe('order routes against PostgreSQL', () => {
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

  describe('create and read (AC-1, AC-2, AC-3, AC-4, AC-8, AC-18)', () => {
    it('creates a numbered order with merged lines, snapshots, totals, history, and an audit row', async () => {
      const created = await createOrder(
        baseOrder({
          items: [
            { productId: fixtures.simpleProductId, quantity: 2, unitPrice: 900 },
            { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 1 },
            { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 2 },
          ],
          deliveryFee: 100,
          discount: 50,
          shippingAddress: '   ',
          notes: '  Call before delivery  ',
        }),
      );

      expect(created.status).toBe(201);
      const order = created.body.data;
      expect(order).toMatchObject({
        orderNumber: 'ORD-0001',
        status: 'PENDING',
        source: 'FACEBOOK',
        customerName: 'Nusrat Jahan',
        customerPhone: '+8801712345678',
        subtotal: 9300,
        deliveryFee: 100,
        discount: 50,
        total: 9350,
        paidAmount: 0,
        dueAmount: 9350,
        shippingAddress: null,
        notes: 'Call before delivery',
        version: 1,
      });
      expect(order.items).toHaveLength(2);
      expect(order.items[0]).toMatchObject({
        productId: fixtures.simpleProductId,
        variantId: null,
        productName: 'Cotton shirt',
        variantLabel: null,
        price: 900,
        cost: 600,
        quantity: 2,
        subtotal: 1800,
        position: 0,
      });
      expect(order.items[1]).toMatchObject({
        productId: fixtures.variantProductId,
        variantId: fixtures.variantSId,
        productName: 'Panjabi',
        variantLabel: 'S',
        price: 2500,
        cost: 1500,
        quantity: 3,
        subtotal: 7500,
        position: 1,
      });
      expect(order.history).toHaveLength(1);
      expect(order.history[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'PENDING',
        note: null,
        changedByName: 'Maya Owner',
      });

      const detail = await request(app).get(`/api/orders/${order.id}`).set(as(OWNER_TOKEN));
      expect(detail.status).toBe(200);
      expect(detail.body.data).toEqual(order);

      const list = await request(app).get('/api/orders').set(as(OWNER_TOKEN));
      expect(list.status).toBe(200);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.items[0]).toMatchObject({
        id: order.id,
        orderNumber: 'ORD-0001',
        customerName: 'Nusrat Jahan',
        status: 'PENDING',
        total: 9350,
        dueAmount: 9350,
        source: 'FACEBOOK',
        itemCount: 2,
      });

      const audits = await auditRowsFor(order.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        entityType: 'ORDER',
        action: 'ORDER_CREATED',
        userId: OWNER,
      });
      expect(JSON.parse(String(audits[0].metadata))).toEqual({
        orderNumber: 'ORD-0001',
        total: 9350,
      });

      const second = await createOrder(baseOrder({ customerId: fixtures.secondCustomerId }));
      expect(second.status).toBe(201);
      expect(second.body.data.orderNumber).toBe('ORD-0002');

      const otherBusiness = await createOrder(
        baseOrder({
          customerId: fixtures.otherCustomerId,
          items: [{ productId: fixtures.otherProductId, quantity: 1 }],
        }),
        OUTSIDER_TOKEN,
        undefined,
        OTHER_BIZ,
      );
      expect(otherBusiness.status).toBe(201);
      expect(otherBusiness.body.data.orderNumber).toBe('ORD-0001');
    });

    // covers AC-2: an existing counter is authoritative and keeps a four digit number
    it('continues from an existing counter without colliding', async () => {
      await getDb().insert(businessOrderCounters).values({ businessId: BIZ, lastNumber: 7 });

      const created = await createOrder(baseOrder());

      expect(created.status).toBe(201);
      expect(created.body.data.orderNumber).toBe('ORD-0008');
      const counter = await getDb()
        .select()
        .from(businessOrderCounters)
        .where(eq(businessOrderCounters.businessId, BIZ));
      expect(counter[0].lastNumber).toBe(8);
    });

    it('keeps snapshots when the customer and catalog change later', async () => {
      const created = await createOrder(
        baseOrder({
          items: [
            { productId: fixtures.simpleProductId, quantity: 2 },
            { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 1 },
          ],
        }),
      );
      expect(created.status).toBe(201);

      await getDb()
        .update(customers)
        .set({ name: 'Renamed Buyer', phone: '+8801999999999' })
        .where(eq(customers.id, fixtures.customerId));
      await getDb()
        .update(products)
        .set({ name: 'Renamed shirt', price: 5000, cost: 4000 })
        .where(eq(products.id, fixtures.simpleProductId));

      const detail = await request(app)
        .get(`/api/orders/${created.body.data.id}`)
        .set(as(OWNER_TOKEN));
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({
        customerName: 'Nusrat Jahan',
        customerPhone: '+8801712345678',
      });
      expect(detail.body.data.items[0]).toMatchObject({
        productName: 'Cotton shirt',
        price: 1000,
        cost: 600,
      });
    });

    // covers AC-13: an order stays readable after its customer and product are archived
    it('keeps an archived customer and product readable from snapshots', async () => {
      const created = await createOrder(baseOrder());
      expect(created.status).toBe(201);

      await getDb()
        .update(customers)
        .set({ archivedAt: new Date() })
        .where(eq(customers.id, fixtures.customerId));
      await getDb()
        .update(products)
        .set({ isArchived: true, archivedAt: new Date() })
        .where(eq(products.id, fixtures.simpleProductId));

      const detail = await request(app)
        .get(`/api/orders/${created.body.data.id}`)
        .set(as(OWNER_TOKEN));

      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({
        customerName: 'Nusrat Jahan',
        customerPhone: '+8801712345678',
      });
      expect(detail.body.data.items[0]).toMatchObject({
        productId: fixtures.simpleProductId,
        productName: 'Cotton shirt',
        price: 1000,
        cost: 600,
      });
    });

    // covers AC-4: every amount is computed on the server, including the inclusive cap
    it('ignores client money fields and accepts a total at the cap', async () => {
      const created = await createOrder(
        baseOrder({
          items: [{ productId: fixtures.simpleProductId, quantity: 20, unitPrice: 100_000_000 }],
          subtotal: 1,
          total: 1,
          paidAmount: 500,
          dueAmount: 0,
        }),
      );

      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        subtotal: 2_000_000_000,
        total: 2_000_000_000,
        paidAmount: 0,
        dueAmount: 2_000_000_000,
      });

      const overTheCap = await createOrder(
        baseOrder({
          items: [{ productId: fixtures.simpleProductId, quantity: 20, unitPrice: 100_000_000 }],
          deliveryFee: 1,
          confirmDuplicate: true,
        }),
      );

      expect(overTheCap.status).toBe(400);
      expect(overTheCap.body.fields).toEqual(['total']);
      expect(await countOrders()).toBe(1);
    });

    // covers AC-1 and AC-11: same pair rows merge before the 50 line limit is checked
    it('creates an order from more than 50 raw rows that merge into one line', async () => {
      const created = await createOrder(
        baseOrder({
          items: Array.from({ length: 60 }, () => ({
            productId: fixtures.simpleProductId,
            quantity: 1,
            unitPrice: 900,
          })),
        }),
      );

      expect(created.status).toBe(201);
      expect(created.body.data.items).toHaveLength(1);
      expect(created.body.data.items[0]).toMatchObject({
        productId: fixtures.simpleProductId,
        quantity: 60,
        subtotal: 54_000,
      });
      expect(created.body.data.subtotal).toBe(54_000);
      expect(created.body.data.total).toBe(54_000);
    });
  });

  describe('validation and references (AC-1, AC-11, AC-12, AC-13)', () => {
    it('rejects archived, unknown, cross tenant, conflicting, and out of range input without writing', async () => {
      await getDb()
        .update(customers)
        .set({ archivedAt: new Date() })
        .where(eq(customers.id, fixtures.customerId));
      const archivedCustomer = await createOrder(baseOrder());
      expect(archivedCustomer.status).toBe(409);
      expect(archivedCustomer.body.error).toBe('CUSTOMER_ARCHIVED');

      await getDb()
        .update(customers)
        .set({ archivedAt: null })
        .where(eq(customers.id, fixtures.customerId));
      await getDb()
        .update(products)
        .set({ isArchived: true, archivedAt: new Date() })
        .where(eq(products.id, fixtures.simpleProductId));
      const archivedProduct = await createOrder(baseOrder());
      expect(archivedProduct.status).toBe(400);
      expect(archivedProduct.body).toMatchObject({
        error: 'VALIDATION_ERROR',
        fields: ['items'],
      });

      await getDb()
        .update(products)
        .set({ isArchived: false, archivedAt: null })
        .where(eq(products.id, fixtures.simpleProductId));

      const unknownProduct = await createOrder(
        baseOrder({
          items: [{ productId: '00000000-0000-0000-0000-0000000000ff', quantity: 1 }],
        }),
      );
      expect(unknownProduct.status).toBe(400);
      expect(unknownProduct.body.fields).toEqual(['items']);

      const wrongVariant = await createOrder(
        baseOrder({
          items: [
            {
              productId: fixtures.simpleProductId,
              variantId: fixtures.variantSId,
              quantity: 1,
            },
          ],
        }),
      );
      expect(wrongVariant.status).toBe(400);
      expect(wrongVariant.body.fields).toEqual(['items']);

      const otherBusinessCustomer = await createOrder(
        baseOrder({ customerId: fixtures.otherCustomerId }),
      );
      expect(otherBusinessCustomer.status).toBe(400);
      expect(otherBusinessCustomer.body.fields).toEqual(['customerId']);

      const conflictingPrices = await createOrder(
        baseOrder({
          items: [
            { productId: fixtures.simpleProductId, quantity: 1, unitPrice: 100 },
            { productId: fixtures.simpleProductId, quantity: 1, unitPrice: 200 },
          ],
        }),
      );
      expect(conflictingPrices.status).toBe(400);
      expect(conflictingPrices.body.fields).toEqual(['items']);

      const mergedTooLarge = await createOrder(
        baseOrder({
          items: [
            { productId: fixtures.simpleProductId, quantity: 1000 },
            { productId: fixtures.simpleProductId, quantity: 1 },
          ],
        }),
      );
      expect(mergedTooLarge.status).toBe(400);
      expect(mergedTooLarge.body.fields).toEqual(['items']);

      const discountTooHigh = await createOrder(baseOrder({ discount: 1001 }));
      expect(discountTooHigh.status).toBe(400);
      expect(discountTooHigh.body.fields).toEqual(['discount']);

      const bulkProducts = await getDb()
        .insert(products)
        .values(
          Array.from({ length: 51 }, (_, index) => ({
            businessId: BIZ,
            categoryId: fixtures.categoryId,
            name: `Bulk product ${index}`,
            price: 100,
          })),
        )
        .returning({ id: products.id });

      const tooManyLines = await createOrder(
        baseOrder({
          items: bulkProducts.map((product) => ({ productId: product.id, quantity: 1 })),
        }),
      );
      expect(tooManyLines.status).toBe(400);
      expect(tooManyLines.body).toMatchObject({
        error: 'VALIDATION_ERROR',
        fields: ['items'],
      });

      const aboveTheRawCap = await createOrder(
        baseOrder({
          items: Array.from({ length: 201 }, () => ({
            productId: fixtures.simpleProductId,
            quantity: 1,
          })),
        }),
      );
      expect(aboveTheRawCap.status).toBe(400);
      expect(aboveTheRawCap.body.fields).toEqual(['items']);

      expect(await countOrders()).toBe(0);
    });

    // covers AC-1 and AC-12: a buyer or catalog row outside this business is a field error
    it('rejects an unknown buyer and foreign catalog references', async () => {
      const before = await countOrders();

      const unknownCustomer = await createOrder(
        baseOrder({ customerId: '00000000-0000-0000-0000-0000000000aa' }),
      );
      expect(unknownCustomer.status).toBe(400);
      expect(unknownCustomer.body.fields).toEqual(['customerId']);

      const foreignProduct = await createOrder(
        baseOrder({ items: [{ productId: fixtures.otherProductId, quantity: 1 }] }),
      );
      expect(foreignProduct.status).toBe(400);
      expect(foreignProduct.body.fields).toEqual(['items']);

      const foreignVariantRows = await getDb()
        .insert(productVariants)
        .values({
          businessId: OTHER_BIZ,
          productId: fixtures.otherProductId,
          combination: { Size: 'L' },
          price: 700,
          position: 0,
        })
        .returning({ id: productVariants.id });

      const foreignVariant = await createOrder(
        baseOrder({
          items: [
            {
              productId: fixtures.simpleProductId,
              variantId: foreignVariantRows[0].id,
              quantity: 1,
            },
          ],
        }),
      );
      expect(foreignVariant.status).toBe(400);
      expect(foreignVariant.body.fields).toEqual(['items']);

      expect(await countOrders()).toBe(before);
    });

    // covers AC-4 and AC-11: the service enforces the caps and the discount boundary
    it('enforces the subtotal and total caps and allows a discount equal to the payable amount', async () => {
      const subtotalOverCap = await createOrder(
        baseOrder({
          items: [{ productId: fixtures.simpleProductId, quantity: 1000, unitPrice: 100_000_000 }],
          confirmDuplicate: true,
        }),
      );
      expect(subtotalOverCap.status).toBe(400);
      expect(subtotalOverCap.body.fields).toEqual(['items']);

      const totalOverCap = await createOrder(
        baseOrder({
          items: [{ productId: fixtures.simpleProductId, quantity: 20, unitPrice: 100_000_000 }],
          deliveryFee: 1,
          confirmDuplicate: true,
        }),
      );
      expect(totalOverCap.status).toBe(400);
      expect(totalOverCap.body.fields).toEqual(['total']);

      const exactDiscount = await createOrder(
        baseOrder({
          items: [{ productId: fixtures.simpleProductId, quantity: 1 }],
          deliveryFee: 500,
          discount: 1500,
          confirmDuplicate: true,
        }),
      );
      expect(exactDiscount.status).toBe(201);
      expect(exactDiscount.body.data).toMatchObject({
        subtotal: 1000,
        total: 0,
        dueAmount: 0,
      });

      const oneTooMuch = await createOrder(
        baseOrder({
          items: [{ productId: fixtures.simpleProductId, quantity: 1 }],
          deliveryFee: 500,
          discount: 1501,
          confirmDuplicate: true,
        }),
      );
      expect(oneTooMuch.status).toBe(400);
      expect(oneTooMuch.body.fields).toEqual(['discount']);
    });

    // covers AC-4 and AC-9: the edit path enforces the discount rule and leaves the order untouched
    it('rejects an edit whose discount exceeds the order total', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;

      const tooHigh = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, discount: 1001 });
      expect(tooHigh.status).toBe(400);
      expect(tooHigh.body.fields).toEqual(['discount']);

      const after = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(after.body.data).toMatchObject({ total: 1000, version: 1, discount: 0 });
    });

    // covers AC-9, AC-10, and AC-12: every write needs a token, and staff can read
    it('requires a token on every write and lets staff read the queue', async () => {
      const created = await createOrder(baseOrder());
      expect(created.status).toBe(201);
      const orderId = created.body.data.id;

      const postWithoutToken = await request(app)
        .post('/api/orders')
        .send(baseOrder({ confirmDuplicate: true }));
      expect(postWithoutToken.status).toBe(401);

      const patchWithoutToken = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ version: 1, notes: 'no token' });
      expect(patchWithoutToken.status).toBe(401);

      const statusWithoutToken = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .send({ status: 'CONFIRMED', version: 1 });
      expect(statusWithoutToken.status).toBe(401);

      const staffList = await request(app).get('/api/orders').set(as(STAFF_TOKEN));
      expect(staffList.status).toBe(200);
      expect(staffList.body.data.items.some((item: { id: string }) => item.id === orderId)).toBe(
        true,
      );

      const staffDetail = await request(app).get(`/api/orders/${orderId}`).set(as(STAFF_TOKEN));
      expect(staffDetail.status).toBe(200);
    });

    // covers AC-9 and AC-12: a missing, malformed, or foreign id is a 404 on edit
    it('returns 404 for an edit on a missing, malformed, or foreign order', async () => {
      const missing = await request(app)
        .patch('/api/orders/00000000-0000-0000-0000-0000000000ff')
        .set(as(OWNER_TOKEN))
        .send({ version: 1, notes: 'missing' });
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('NOT_FOUND');

      const malformed = await request(app)
        .patch('/api/orders/not-a-uuid')
        .set(as(OWNER_TOKEN))
        .send({ version: 1, notes: 'malformed' });
      expect(malformed.status).toBe(404);

      const foreign = await createOrder(
        {
          customerId: fixtures.otherCustomerId,
          items: [{ productId: fixtures.otherProductId, quantity: 1 }],
          source: 'DIRECT',
        },
        OUTSIDER_TOKEN,
        undefined,
        OTHER_BIZ,
      );
      expect(foreign.status).toBe(201);

      const crossTenant = await request(app)
        .patch(`/api/orders/${foreign.body.data.id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, notes: 'not mine' });
      expect(crossTenant.status).toBe(404);
      expect(crossTenant.body.error).toBe('NOT_FOUND');
    });

    // covers AC-11: the edit payload needs a version and reports the bad field
    it('rejects an edit without a version', async () => {
      const created = await createOrder(baseOrder());

      const missingVersion = await request(app)
        .patch(`/api/orders/${created.body.data.id}`)
        .set(as(OWNER_TOKEN))
        .send({ notes: 'no version' });
      expect(missingVersion.status).toBe(400);
      expect(missingVersion.body.fields).toEqual(['version']);
    });

    it('accepts staff writes and rejects missing or foreign authentication', async () => {
      const staffOrder = await createOrder(baseOrder(), STAFF_TOKEN);
      expect(staffOrder.status).toBe(201);
      const orderId = staffOrder.body.data.id;

      const noToken = await request(app).get('/api/orders');
      expect(noToken.status).toBe(401);

      const noActor = await createOrder(
        baseOrder({ customerId: fixtures.secondCustomerId, confirmDuplicate: true }),
        NO_ACTOR_TOKEN,
      );
      expect(noActor.status).toBe(401);

      const noBusiness = await request(app)
        .get('/api/orders')
        .set({ authorization: `Bearer ${OWNER_TOKEN}` });
      expect(noBusiness.status).toBe(400);

      const outsider = await request(app).get('/api/orders').set(as(OUTSIDER_TOKEN, BIZ));
      expect(outsider.status).toBe(403);

      const foreignOrder = await request(app)
        .get(`/api/orders/${orderId}`)
        .set(as(OUTSIDER_TOKEN, OTHER_BIZ));
      expect(foreignOrder.status).toBe(404);

      const malformed = await request(app).get('/api/orders/not-a-uuid').set(as(OWNER_TOKEN));
      expect(malformed.status).toBe(404);
    });

    // covers AC-12: staff can edit an order and move its status, not just create one
    it('lets staff edit an order and change its status', async () => {
      const created = await createOrder(baseOrder());
      expect(created.status).toBe(201);
      const orderId = created.body.data.id;

      const edited = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(STAFF_TOKEN))
        .send({ version: 1, notes: 'Staff edit' });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ notes: 'Staff edit', version: 2 });

      const confirmed = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(STAFF_TOKEN))
        .send({ status: 'CONFIRMED', version: 2, note: 'Staff confirmed' });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data).toMatchObject({ status: 'CONFIRMED', version: 3 });

      const detail = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(detail.body.data.history.at(-1)).toMatchObject({
        fromStatus: 'PENDING',
        toStatus: 'CONFIRMED',
        note: 'Staff confirmed',
        changedByName: 'Sam Staff',
      });
      const updateAudit = (await auditRowsFor(orderId)).find(
        (row) => row.action === 'ORDER_UPDATED',
      );
      expect(updateAudit?.userId).toBe(STAFF);
    });
  });

  describe('duplicates and idempotency (AC-5, AC-6, AC-15)', () => {
    it('warns on the same customer and item set, then honors the confirmation flag', async () => {
      const items = [
        { productId: fixtures.simpleProductId, quantity: 1 },
        { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 1 },
      ];
      const first = await createOrder(baseOrder({ items }));
      expect(first.status).toBe(201);

      const duplicate = await createOrder(
        baseOrder({
          items: [
            { productId: fixtures.simpleProductId, quantity: 5 },
            { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 7 },
          ],
        }),
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({
        error: 'DUPLICATE_ORDER',
        existingOrder: {
          id: first.body.data.id,
          orderNumber: first.body.data.orderNumber,
          status: 'PENDING',
          total: first.body.data.total,
        },
      });

      const confirmed = await createOrder(baseOrder({ items, confirmDuplicate: true }));
      expect(confirmed.status).toBe(201);
      expect(confirmed.body.data.id).not.toBe(first.body.data.id);

      const differentItems = await createOrder(
        baseOrder({ items: [{ productId: fixtures.simpleProductId, quantity: 1 }] }),
      );
      expect(differentItems.status).toBe(201);

      const differentCustomer = await createOrder(
        baseOrder({ customerId: fixtures.secondCustomerId, items }),
      );
      expect(differentCustomer.status).toBe(201);

      const cancelFirst = await request(app)
        .post(`/api/orders/${first.body.data.id}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 1 });
      expect(cancelFirst.status).toBe(200);
      const cancelSecond = await request(app)
        .post(`/api/orders/${confirmed.body.data.id}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 1 });
      expect(cancelSecond.status).toBe(200);

      const afterCancel = await createOrder(baseOrder({ items }));
      expect(afterCancel.status).toBe(201);

      const oldOrder = await createOrder(
        baseOrder({
          customerId: fixtures.thirdCustomerId,
          items: [
            { productId: fixtures.variantProductId, variantId: fixtures.variantMId, quantity: 1 },
          ],
        }),
      );
      expect(oldOrder.status).toBe(201);
      await getDb()
        .update(orders)
        .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where(eq(orders.id, oldOrder.body.data.id));

      const afterWindow = await createOrder(
        baseOrder({
          customerId: fixtures.thirdCustomerId,
          items: [
            { productId: fixtures.variantProductId, variantId: fixtures.variantMId, quantity: 1 },
          ],
        }),
      );
      expect(afterWindow.status).toBe(201);
    });

    // covers AC-5: the 24 hour window includes the time just before the boundary and excludes the time after it
    it('warns just inside the 24 hour window and not just outside it', async () => {
      const items = [
        { productId: fixtures.variantProductId, variantId: fixtures.variantMId, quantity: 1 },
      ];
      const first = await createOrder(baseOrder({ customerId: fixtures.thirdCustomerId, items }));
      expect(first.status).toBe(201);

      await getDb()
        .update(orders)
        .set({ createdAt: sql`now() - interval '23 hours 59 minutes 59 seconds'` })
        .where(eq(orders.id, first.body.data.id));

      const inside = await createOrder(baseOrder({ customerId: fixtures.thirdCustomerId, items }));
      expect(inside.status).toBe(409);
      expect(inside.body.error).toBe('DUPLICATE_ORDER');

      await getDb()
        .update(orders)
        .set({ createdAt: sql`now() - interval '24 hours 1 minute'` })
        .where(eq(orders.id, first.body.data.id));

      const outside = await createOrder(baseOrder({ customerId: fixtures.thirdCustomerId, items }));
      expect(outside.status).toBe(201);
    });

    it('replays an idempotency key before body checks and settles a race on one key', async () => {
      const key = 'order-key-1';
      const first = await createOrder(baseOrder({ notes: 'first' }), OWNER_TOKEN, key);
      expect(first.status).toBe(201);
      const orderId = first.body.data.id;

      const replay = await createOrder(
        baseOrder({ notes: 'a different payload' }),
        OWNER_TOKEN,
        key,
      );
      expect(replay.status).toBe(200);
      expect(replay.body.data.id).toBe(orderId);
      expect(replay.body.data.notes).toBe('first');

      const secondKey = await createOrder(
        baseOrder({ customerId: fixtures.secondCustomerId }),
        OWNER_TOKEN,
        'order-key-2',
      );
      expect(secondKey.status).toBe(201);
      expect(secondKey.body.data.id).not.toBe(orderId);

      const longKey = await createOrder(baseOrder(), OWNER_TOKEN, 'x'.repeat(101));
      expect(longKey.status).toBe(400);
      expect(longKey.body.fields).toEqual(['Idempotency-Key']);

      // covers AC-6: the key is trimmed and accepted at both length edges
      const shortKey = await createOrder(baseOrder({ confirmDuplicate: true }), OWNER_TOKEN, 'k');
      expect(shortKey.status).toBe(201);

      const exactKey = await createOrder(
        baseOrder({ confirmDuplicate: true }),
        OWNER_TOKEN,
        'y'.repeat(100),
      );
      expect(exactKey.status).toBe(201);
      expect(exactKey.body.data.id).not.toBe(shortKey.body.data.id);

      const blankKey = await createOrder(baseOrder(), OWNER_TOKEN, '   ');
      expect(blankKey.status).toBe(400);
      expect(blankKey.body.fields).toEqual(['Idempotency-Key']);

      const raceBody = baseOrder({
        customerId: fixtures.thirdCustomerId,
        items: [
          { productId: fixtures.variantProductId, variantId: fixtures.variantMId, quantity: 2 },
        ],
        confirmDuplicate: true,
      });
      const [left, right] = await Promise.all([
        createOrder(raceBody, OWNER_TOKEN, 'race-key'),
        createOrder(raceBody, OWNER_TOKEN, 'race-key'),
      ]);
      expect(left.body.data.id).toBe(right.body.data.id);
      expect([left.status, right.status].sort()).toEqual([200, 201]);

      const rows = await getDb()
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(eq(orders.idempotencyKey, 'race-key'));
      expect(Number(rows[0].count)).toBe(1);
    });

    // covers AC-6: a replay answers before the request body is validated
    it('replays the stored order even when the replay body is invalid', async () => {
      const key = 'replay-before-body';
      const first = await createOrder(baseOrder(), OWNER_TOKEN, key);
      expect(first.status).toBe(201);

      const invalidReplay = await request(app)
        .post('/api/orders')
        .set(as(OWNER_TOKEN))
        .set('Idempotency-Key', key)
        .send({ customerId: 'not-a-uuid', items: [] });

      expect(invalidReplay.status).toBe(200);
      expect(invalidReplay.body.data.id).toBe(first.body.data.id);
      expect(await countOrders()).toBe(1);
    });
  });

  describe('list, search, and cursor (AC-7)', () => {
    it('filters by status, searches snapshots and digits, escapes wildcards, and binds cursors', async () => {
      const first = await createOrder(
        baseOrder({
          customerId: fixtures.customerId,
          items: [{ productId: fixtures.simpleProductId, quantity: 1 }],
        }),
      );
      const second = await createOrder(
        baseOrder({
          customerId: fixtures.secondCustomerId,
          items: [
            { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 1 },
          ],
        }),
      );
      const third = await createOrder(
        baseOrder({
          customerId: fixtures.thirdCustomerId,
          items: [
            { productId: fixtures.variantProductId, variantId: fixtures.variantMId, quantity: 1 },
          ],
        }),
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(third.status).toBe(201);

      await request(app)
        .post(`/api/orders/${second.body.data.id}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      await request(app)
        .post(`/api/orders/${third.body.data.id}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 1 });

      const all = await request(app).get('/api/orders').set(as(OWNER_TOKEN));
      expect(all.status).toBe(200);
      expect(all.body.data.items.map((item: { id: string }) => item.id)).toEqual([
        third.body.data.id,
        second.body.data.id,
        first.body.data.id,
      ]);

      const confirmed = await request(app).get('/api/orders?status=CONFIRMED').set(as(OWNER_TOKEN));
      expect(confirmed.body.data.items.map((item: { id: string }) => item.id)).toEqual([
        second.body.data.id,
      ]);

      const twoStatuses = await request(app)
        .get('/api/orders?status=CONFIRMED,CANCELLED')
        .set(as(OWNER_TOKEN));
      expect(twoStatuses.body.data.items).toHaveLength(2);

      const byName = await request(app).get('/api/orders?q=nusrat').set(as(OWNER_TOKEN));
      expect(byName.body.data.items.map((item: { id: string }) => item.id)).toEqual([
        first.body.data.id,
      ]);

      const byNumber = await request(app)
        .get(`/api/orders?q=${encodeURIComponent('ORD-0002')}`)
        .set(as(OWNER_TOKEN));
      expect(byNumber.body.data.items.map((item: { id: string }) => item.id)).toEqual([
        second.body.data.id,
      ]);

      const byPhone = await request(app).get('/api/orders?q=181234').set(as(OWNER_TOKEN));
      expect(byPhone.body.data.items.map((item: { id: string }) => item.id)).toEqual([
        second.body.data.id,
      ]);

      const percentCustomer = await seedCustomer(BIZ, {
        name: 'Percent % Buyer',
        phone: '+8801555555555',
      });
      const percentProduct = await seedProduct(
        BIZ,
        (
          await getDb()
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.businessId, BIZ))
            .limit(1)
        )[0].id,
        { name: 'Percent product', price: 100 },
      );
      const percentOrder = await createOrder(
        baseOrder({
          customerId: percentCustomer,
          items: [{ productId: percentProduct.id, quantity: 1 }],
        }),
      );
      expect(percentOrder.status).toBe(201);

      const literalPercent = await request(app)
        .get(`/api/orders?q=${encodeURIComponent('%')}`)
        .set(as(OWNER_TOKEN));
      expect(literalPercent.body.data.items.map((item: { id: string }) => item.id)).toEqual([
        percentOrder.body.data.id,
      ]);

      const firstPage = await request(app).get('/api/orders?limit=1').set(as(OWNER_TOKEN));
      expect(firstPage.body.data.items).toHaveLength(1);
      expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));

      const secondPage = await request(app)
        .get(`/api/orders?limit=1&cursor=${encodeURIComponent(firstPage.body.data.nextCursor)}`)
        .set(as(OWNER_TOKEN));
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.data.items).toHaveLength(1);
      expect(secondPage.body.data.items[0].id).not.toBe(firstPage.body.data.items[0].id);

      const rebound = await request(app)
        .get(
          `/api/orders?status=CONFIRMED&limit=1&cursor=${encodeURIComponent(firstPage.body.data.nextCursor)}`,
        )
        .set(as(OWNER_TOKEN));
      expect(rebound.status).toBe(400);
      expect(rebound.body.fields).toEqual(['cursor']);

      const reboundLimit = await request(app)
        .get(`/api/orders?limit=2&cursor=${encodeURIComponent(firstPage.body.data.nextCursor)}`)
        .set(as(OWNER_TOKEN));
      expect(reboundLimit.status).toBe(400);
      expect(reboundLimit.body.fields).toEqual(['cursor']);

      const reboundSearch = await request(app)
        .get(
          `/api/orders?q=nusrat&limit=1&cursor=${encodeURIComponent(firstPage.body.data.nextCursor)}`,
        )
        .set(as(OWNER_TOKEN));
      expect(reboundSearch.status).toBe(400);
      expect(reboundSearch.body.fields).toEqual(['cursor']);

      for (const query of ['limit=0', 'limit=51', 'cursor=garbage']) {
        const invalid = await request(app).get(`/api/orders?${query}`).set(as(OWNER_TOKEN));
        expect(invalid.status).toBe(400);
      }

      const tooLongSearch = await request(app)
        .get(`/api/orders?q=${'a'.repeat(101)}`)
        .set(as(OWNER_TOKEN));
      expect(tooLongSearch.status).toBe(400);
      expect(tooLongSearch.body.fields).toEqual(['q']);

      await createOrder(
        baseOrder({
          customerId: fixtures.otherCustomerId,
          items: [{ productId: fixtures.otherProductId, quantity: 1 }],
        }),
        OUTSIDER_TOKEN,
        undefined,
        OTHER_BIZ,
      );
      const scoped = await request(app).get('/api/orders').set(as(OWNER_TOKEN));
      expect(
        scoped.body.data.items.every(
          (item: { customerName: string }) => item.customerName !== 'Other Buyer',
        ),
      ).toBe(true);
    });

    // covers AC-7: an underscore is matched literally, not as a single character wildcard
    it('treats an underscore as a literal search character', async () => {
      const categoryId = (
        await getDb()
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.businessId, BIZ))
          .limit(1)
      )[0].id;
      const product = await seedProduct(BIZ, categoryId, {
        name: 'Underscore product',
        price: 100,
      });
      const underscoreCustomer = await seedCustomer(BIZ, {
        name: 'Under_score Buyer',
        phone: '+8801666666666',
      });
      const wildcardCustomer = await seedCustomer(BIZ, {
        name: 'UnderXscore Buyer',
        phone: '+8801777777777',
      });

      const matching = await createOrder(
        baseOrder({
          customerId: underscoreCustomer,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      );
      const other = await createOrder(
        baseOrder({
          customerId: wildcardCustomer,
          items: [{ productId: product.id, quantity: 1 }],
        }),
      );
      expect(matching.status).toBe(201);
      expect(other.status).toBe(201);

      const literalUnderscore = await request(app)
        .get(`/api/orders?q=${encodeURIComponent('_')}`)
        .set(as(OWNER_TOKEN));
      expect(literalUnderscore.status).toBe(200);
      expect(literalUnderscore.body.data.items.map((item: { id: string }) => item.id)).toEqual([
        matching.body.data.id,
      ]);
    });

    // covers AC-7: the default page is 20 rows and the next cursor never repeats a row
    it('pages 20 rows at a time without repeating a row', async () => {
      for (let index = 0; index < 21; index += 1) {
        const created = await createOrder(baseOrder({ confirmDuplicate: true }));
        expect(created.status).toBe(201);
      }

      const firstPage = await request(app).get('/api/orders').set(as(OWNER_TOKEN));
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.data.items).toHaveLength(20);
      expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));

      const secondPage = await request(app)
        .get(`/api/orders?cursor=${encodeURIComponent(firstPage.body.data.nextCursor)}`)
        .set(as(OWNER_TOKEN));
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.data.items).toHaveLength(1);
      expect(secondPage.body.data.nextCursor).toBeNull();

      const ids = [
        ...firstPage.body.data.items.map((item: { id: string }) => item.id),
        ...secondPage.body.data.items.map((item: { id: string }) => item.id),
      ];
      expect(new Set(ids).size).toBe(21);
    });

    // covers AC-7: an unknown status filter is a field error, not an empty page
    it('rejects an unknown status filter', async () => {
      const unknown = await request(app)
        .get('/api/orders?status=PENDING,ARCHIVED')
        .set(as(OWNER_TOKEN));

      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toBe('VALIDATION_ERROR');
      expect(unknown.body.fields).toEqual(['status']);
    });
  });

  describe('edit (AC-3, AC-9, AC-13, AC-17)', () => {
    it('updates lines by lineId, keeps snapshots, reorders, and writes one audit row', async () => {
      const created = await createOrder(
        baseOrder({
          items: [
            { productId: fixtures.simpleProductId, quantity: 2 },
            { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 1 },
          ],
        }),
      );
      expect(created.status).toBe(201);
      const order = created.body.data;
      const simpleLineId = order.items[0].id;

      const edited = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          customerId: fixtures.secondCustomerId,
          items: [
            {
              lineId: simpleLineId,
              productId: fixtures.simpleProductId,
              variantId: null,
              quantity: 3,
              unitPrice: 1100,
            },
            {
              productId: fixtures.variantProductId,
              variantId: fixtures.variantMId,
              quantity: 2,
            },
          ],
          deliveryFee: 200,
          discount: 100,
          shippingAddress: 'New address',
          notes: 'Updated notes',
        });

      expect(edited.status).toBe(200);
      const updated = edited.body.data;
      expect(updated).toMatchObject({
        customerName: 'Tanvir Ahmed',
        customerPhone: '+8801812345678',
        subtotal: 8900,
        deliveryFee: 200,
        discount: 100,
        total: 9000,
        dueAmount: 9000,
        version: 2,
        shippingAddress: 'New address',
        notes: 'Updated notes',
      });
      expect(updated.items).toHaveLength(2);
      expect(updated.items[0]).toMatchObject({
        id: simpleLineId,
        productName: 'Cotton shirt',
        price: 1100,
        cost: 600,
        quantity: 3,
        subtotal: 3300,
        position: 0,
      });
      expect(updated.items[1]).toMatchObject({
        productId: fixtures.variantProductId,
        variantId: fixtures.variantMId,
        productName: 'Panjabi',
        variantLabel: 'M',
        price: 2800,
        cost: 1600,
        quantity: 2,
        subtotal: 5600,
        position: 1,
      });
      expect(updated.history).toHaveLength(1);

      const audits = await auditRowsFor(order.id);
      const updateAudit = audits.find((row) => row.action === 'ORDER_UPDATED');
      expect(updateAudit).toBeDefined();
      expect(JSON.parse(String(updateAudit?.metadata))).toMatchObject({
        previousTotal: 4500,
        newTotal: 9000,
      });
      expect(JSON.parse(String(updateAudit?.metadata)).changedFields).toEqual(
        expect.arrayContaining([
          'customerId',
          'items',
          'deliveryFee',
          'discount',
          'shippingAddress',
          'notes',
        ]),
      );

      const noOp = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 2,
          customerId: fixtures.secondCustomerId,
          items: [
            {
              lineId: updated.items[0].id,
              productId: fixtures.simpleProductId,
              variantId: null,
              quantity: 3,
              unitPrice: 1100,
            },
            {
              lineId: updated.items[1].id,
              productId: fixtures.variantProductId,
              variantId: fixtures.variantMId,
              quantity: 2,
              unitPrice: 2800,
            },
          ],
          deliveryFee: 200,
          discount: 100,
          shippingAddress: 'New address',
          notes: 'Updated notes',
        });
      expect(noOp.status).toBe(200);
      expect(noOp.body.data.version).toBe(2);
      expect(
        (await auditRowsFor(order.id)).filter((row) => row.action === 'ORDER_UPDATED'),
      ).toHaveLength(1);

      const stale = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, notes: 'stale' });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('ORDER_CHANGED');
    });

    // covers AC-9: changing only the line order still bumps the version and the audit
    it('bumps the version when only the line order changes', async () => {
      const created = await createOrder(
        baseOrder({
          items: [
            { productId: fixtures.simpleProductId, quantity: 1 },
            { productId: fixtures.variantProductId, variantId: fixtures.variantMId, quantity: 2 },
          ],
        }),
      );
      const order = created.body.data;
      const [firstLine, secondLine] = order.items;

      const reordered = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          items: [
            {
              lineId: secondLine.id,
              productId: secondLine.productId,
              variantId: secondLine.variantId,
              quantity: secondLine.quantity,
              unitPrice: secondLine.price,
            },
            {
              lineId: firstLine.id,
              productId: firstLine.productId,
              variantId: firstLine.variantId,
              quantity: firstLine.quantity,
              unitPrice: firstLine.price,
            },
          ],
        });

      expect(reordered.status).toBe(200);
      expect(reordered.body.data.version).toBe(2);
      expect(reordered.body.data.items.map((item: { id: string }) => item.id)).toEqual([
        secondLine.id,
        firstLine.id,
      ]);
      expect(reordered.body.data.items.map((item: { position: number }) => item.position)).toEqual([
        0, 1,
      ]);

      const updateAudit = (await auditRowsFor(order.id)).find(
        (row) => row.action === 'ORDER_UPDATED',
      );
      expect(JSON.parse(String(updateAudit?.metadata)).changedFields).toEqual(['items']);
    });

    // covers AC-9 and AC-17: a source change keeps the totals and names its own audit field
    it('records a source change as its own audit field', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;
      const backdated = new Date('2020-01-01T00:00:00.000Z');
      await getDb().update(orders).set({ updatedAt: backdated }).where(eq(orders.id, orderId));

      const changed = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, source: 'WHATSAPP' });

      expect(changed.status).toBe(200);
      expect(changed.body.data).toMatchObject({
        source: 'WHATSAPP',
        version: 2,
        total: created.body.data.total,
      });
      expect(new Date(changed.body.data.updatedAt).getTime()).toBeGreaterThan(backdated.getTime());

      const updateAudit = (await auditRowsFor(orderId)).find(
        (row) => row.action === 'ORDER_UPDATED',
      );
      expect(JSON.parse(String(updateAudit?.metadata)).changedFields).toEqual(['source']);
    });

    it('validates line identity and accepts archived references only for existing lines', async () => {
      const created = await createOrder(
        baseOrder({
          items: [
            { productId: fixtures.simpleProductId, quantity: 1 },
            { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 1 },
          ],
        }),
      );
      const order = created.body.data;
      const simpleLine = order.items[0];
      const variantLine = order.items[1];

      const unknownLine = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          items: [
            {
              lineId: '00000000-0000-0000-0000-0000000000ff',
              productId: fixtures.simpleProductId,
              quantity: 1,
            },
          ],
        });
      expect(unknownLine.status).toBe(400);
      expect(unknownLine.body.fields).toEqual(['items']);

      const repeated = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          items: [
            {
              lineId: simpleLine.id,
              productId: fixtures.simpleProductId,
              quantity: 1,
            },
            {
              lineId: simpleLine.id,
              productId: fixtures.simpleProductId,
              quantity: 2,
            },
          ],
        });
      expect(repeated.status).toBe(400);
      expect(repeated.body.fields).toEqual(['items']);

      const mismatched = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          items: [
            {
              lineId: simpleLine.id,
              productId: fixtures.variantProductId,
              variantId: fixtures.variantSId,
              quantity: 1,
            },
          ],
        });
      expect(mismatched.status).toBe(400);
      expect(mismatched.body.fields).toEqual(['items']);

      const secondOrder = await createOrder(
        baseOrder({
          customerId: fixtures.secondCustomerId,
          items: [{ productId: fixtures.simpleProductId, quantity: 1 }],
        }),
      );
      const foreignLine = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          items: [
            {
              lineId: secondOrder.body.data.items[0].id,
              productId: fixtures.simpleProductId,
              quantity: 1,
            },
          ],
        });
      expect(foreignLine.status).toBe(400);
      expect(foreignLine.body.fields).toEqual(['items']);

      await getDb()
        .update(products)
        .set({ isArchived: true, archivedAt: new Date() })
        .where(eq(products.id, fixtures.simpleProductId));

      const archivedExisting = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          items: [
            {
              lineId: simpleLine.id,
              productId: fixtures.simpleProductId,
              quantity: 4,
            },
            {
              lineId: variantLine.id,
              productId: fixtures.variantProductId,
              variantId: fixtures.variantSId,
              quantity: 1,
            },
          ],
        });
      expect(archivedExisting.status).toBe(200);
      expect(archivedExisting.body.data.version).toBe(2);
      expect(archivedExisting.body.data.items[0]).toMatchObject({
        productName: 'Cotton shirt',
        quantity: 4,
      });

      const archivedNew = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 2,
          items: [
            {
              lineId: simpleLine.id,
              productId: fixtures.simpleProductId,
              quantity: 4,
            },
            {
              lineId: variantLine.id,
              productId: fixtures.variantProductId,
              variantId: fixtures.variantSId,
              quantity: 1,
            },
            { productId: fixtures.simpleProductId, quantity: 1 },
          ],
        });
      expect(archivedNew.status).toBe(400);
      expect(archivedNew.body.fields).toEqual(['items']);

      await getDb().delete(productVariants).where(eq(productVariants.id, fixtures.variantSId));

      const afterVariantDelete = await request(app)
        .get(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN));
      expect(afterVariantDelete.status).toBe(200);
      const deletedLine = afterVariantDelete.body.data.items.find(
        (item: { id: string }) => item.id === variantLine.id,
      );
      expect(deletedLine).toMatchObject({
        variantId: null,
        variantLabel: 'S',
        productName: 'Panjabi',
        cost: 1500,
      });

      const editDeletedVariant = await request(app)
        .patch(`/api/orders/${order.id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 2,
          items: [
            {
              lineId: simpleLine.id,
              productId: fixtures.simpleProductId,
              quantity: 4,
            },
            {
              lineId: variantLine.id,
              productId: fixtures.variantProductId,
              variantId: null,
              quantity: 2,
              unitPrice: 2500,
            },
          ],
        });
      expect(editDeletedVariant.status).toBe(200);
      expect(editDeletedVariant.body.data.version).toBe(3);
      expect(
        editDeletedVariant.body.data.items.find(
          (item: { id: string }) => item.id === variantLine.id,
        ),
      ).toMatchObject({ variantLabel: 'S', quantity: 2, price: 2500 });
    });

    it('locks edits after shipping and reports the status lock before the version check', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;

      for (const [status, version] of [
        ['CONFIRMED', 1],
        ['PROCESSING', 2],
        ['SHIPPED', 3],
      ] as const) {
        const moved = await request(app)
          .post(`/api/orders/${orderId}/status`)
          .set(as(OWNER_TOKEN))
          .send({ status, version });
        expect(moved.status).toBe(200);
      }

      const locked = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, notes: 'too late' });
      expect(locked.status).toBe(409);
      expect(locked.body.error).toBe('ORDER_LOCKED');
    });

    // covers AC-13: an archived customer cannot become the buyer on an edit
    it('refuses an archived customer when the buyer changes on edit', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;

      await getDb()
        .update(customers)
        .set({ archivedAt: new Date() })
        .where(eq(customers.id, fixtures.secondCustomerId));

      const archived = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, customerId: fixtures.secondCustomerId });

      expect(archived.status).toBe(409);
      expect(archived.body.error).toBe('CUSTOMER_ARCHIVED');

      const detail = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(detail.body.data).toMatchObject({
        customerName: 'Nusrat Jahan',
        customerId: fixtures.customerId,
        version: 1,
      });
    });

    // covers AC-13: archiving the current buyer does not block an unrelated edit
    it('keeps an unchanged archived buyer on an edit', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;

      await getDb()
        .update(customers)
        .set({ archivedAt: new Date() })
        .where(eq(customers.id, fixtures.customerId));

      const edited = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, customerId: fixtures.customerId, notes: 'Still the same buyer' });

      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({
        customerId: fixtures.customerId,
        customerName: 'Nusrat Jahan',
        notes: 'Still the same buyer',
        version: 2,
      });
    });
  });

  describe('delivery deadline (AC-1, AC-7, AC-8, AC-9, AC-11, AC-17, AC-19)', () => {
    it('stores an omitted, null, and blank deadline as null and a real date as sent', async () => {
      const omitted = await createOrder(baseOrder());
      expect(omitted.body.data.deliveryDeadline).toBeNull();

      const blank = await createOrder(
        baseOrder({ customerId: fixtures.secondCustomerId, deliveryDeadline: '   ' }),
      );
      expect(blank.body.data.deliveryDeadline).toBeNull();

      const explicitNull = await createOrder(
        baseOrder({ customerId: fixtures.thirdCustomerId, deliveryDeadline: null }),
      );
      expect(explicitNull.body.data.deliveryDeadline).toBeNull();

      const dated = await createOrder(
        baseOrder({ deliveryDeadline: '2026-11-05', confirmDuplicate: true }),
      );
      expect(dated.body.data.deliveryDeadline).toBe('2026-11-05');
      expect(dated.body.data.version).toBe(1);

      const row = await findOrder(dated.body.data.id);
      expect(row.deliveryDeadline).toBe('2026-11-05');
    });

    it('accepts a past date and rejects an impossible calendar day without writing', async () => {
      const before = await countOrders();
      const past = await createOrder(baseOrder({ deliveryDeadline: '2020-01-01' }));
      expect(past.status).toBe(201);
      expect(past.body.data.deliveryDeadline).toBe('2020-01-01');

      for (const value of ['2026-02-30', '2026-13-01', '2026-1-1']) {
        const bad = await createOrder(baseOrder({ deliveryDeadline: value }));
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('VALIDATION_ERROR');
        expect(bad.body.fields).toContain('deliveryDeadline');
      }
      expect(await countOrders()).toBe(before + 1);
    });

    it('carries the deadline on the list row and the detail', async () => {
      const created = await createOrder(baseOrder({ deliveryDeadline: '2026-11-05' }));
      const orderId = created.body.data.id;

      const list = await request(app).get('/api/orders?status=PENDING').set(as(OWNER_TOKEN));
      expect(list.status).toBe(200);
      const row = list.body.data.items.find((item: { id: string }) => item.id === orderId);
      expect(row.deliveryDeadline).toBe('2026-11-05');

      const detail = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(detail.body.data.deliveryDeadline).toBe('2026-11-05');
    });

    it('sets, changes, and clears the deadline with one version step and a named audit field each time', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;

      const set = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, deliveryDeadline: '2026-11-05' });
      expect(set.status).toBe(200);
      expect(set.body.data.deliveryDeadline).toBe('2026-11-05');
      expect(set.body.data.version).toBe(2);

      const sameValue = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2, deliveryDeadline: '2026-11-05' });
      expect(sameValue.status).toBe(200);
      expect(sameValue.body.data.version).toBe(2);

      const cleared = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2, deliveryDeadline: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.deliveryDeadline).toBeNull();
      expect(cleared.body.data.version).toBe(3);

      const audits = await auditRowsFor(orderId);
      const uuids = audits.filter((row) => row.action === 'ORDER_UPDATED');
      expect(uuids).toHaveLength(2);
      for (const row of uuids) {
        expect(JSON.parse(String(row.metadata))).toMatchObject({
          changedFields: ['deliveryDeadline'],
        });
      }
    });

    it('locks a deadline change once the order moves past confirmed', async () => {
      const created = await createOrder(baseOrder({ deliveryDeadline: '2020-01-01' }));
      const orderId = created.body.data.id;

      await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'PROCESSING', version: 2 });

      const locked = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 3, deliveryDeadline: '2026-11-05' });

      expect(locked.status).toBe(409);
      expect(locked.body.error).toBe('ORDER_LOCKED');

      const detail = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(detail.body.data.deliveryDeadline).toBe('2020-01-01');
    });

    it('does not let a deadline change alter totals and rejects a stale version', async () => {
      const created = await createOrder(baseOrder({ deliveryDeadline: '2026-11-05' }));
      const orderId = created.body.data.id;
      const before = created.body.data;

      const stale = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 99, deliveryDeadline: '2026-12-25' });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('ORDER_CHANGED');

      const changed = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, deliveryDeadline: '2026-12-25' });
      expect(changed.status).toBe(200);
      expect(changed.body.data.total).toBe(before.total);
      expect(changed.body.data.subtotal).toBe(before.subtotal);
      expect(changed.body.data.dueAmount).toBe(before.dueAmount);
      expect(changed.body.data.deliveryDeadline).toBe('2026-12-25');
    });

    // covers AC-9 and AC-19: a blank edit clears the promise, and a repeat clear is a no-op
    it('clears a deadline with a blank value and ignores a repeat clear', async () => {
      const created = await createOrder(baseOrder({ deliveryDeadline: '2026-11-05' }));
      const orderId = created.body.data.id;

      const blankClear = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, deliveryDeadline: '   ' });
      expect(blankClear.status).toBe(200);
      expect(blankClear.body.data.deliveryDeadline).toBeNull();
      expect(blankClear.body.data.version).toBe(2);

      const repeat = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2, deliveryDeadline: null });
      expect(repeat.status).toBe(200);
      expect(repeat.body.data.deliveryDeadline).toBeNull();
      expect(repeat.body.data.version).toBe(2);
      expect(
        (await auditRowsFor(orderId)).filter((row) => row.action === 'ORDER_UPDATED'),
      ).toHaveLength(1);

      const invalid = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2, deliveryDeadline: '2026-02-30' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.fields).toEqual(['deliveryDeadline']);
    });

    // covers AC-9 and AC-19: a confirmed order can still change its promise
    it('lets a confirmed order change its deadline', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;

      const confirmed = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      expect(confirmed.status).toBe(200);

      const dated = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2, deliveryDeadline: '2026-12-01' });
      expect(dated.status).toBe(200);
      expect(dated.body.data).toMatchObject({
        status: 'CONFIRMED',
        deliveryDeadline: '2026-12-01',
        version: 3,
      });
    });
  });

  describe('status workflow (AC-10, AC-18)', () => {
    it('walks the allowed path, records actors and notes, and rejects invalid moves', async () => {
      const created = await createOrder(
        baseOrder({ items: [{ productId: fixtures.simpleProductId, quantity: 2 }] }),
      );
      const orderId = created.body.data.id;
      const total = created.body.data.total;

      const confirmed = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1, note: 'Payment confirmed' });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data).toMatchObject({ status: 'CONFIRMED', version: 2, total });

      await getDb().update(users).set({ name: 'Maya Renamed' }).where(eq(users.id, OWNER));

      const invalid = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'DELIVERED', version: 2 });
      expect(invalid.status).toBe(409);
      expect(invalid.body.error).toBe('INVALID_STATUS_TRANSITION');

      const stale = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'PROCESSING', version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('ORDER_CHANGED');

      let version = 2;
      for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED', 'RETURNED'] as const) {
        const moved = await request(app)
          .post(`/api/orders/${orderId}/status`)
          .set(as(OWNER_TOKEN))
          .send({ status, version });
        expect(moved.status).toBe(200);
        version += 1;
      }

      const detail = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(detail.body.data).toMatchObject({ status: 'RETURNED', version: 6, total });
      expect(detail.body.data.history).toHaveLength(6);
      expect(detail.body.data.history[1]).toMatchObject({
        fromStatus: 'PENDING',
        toStatus: 'CONFIRMED',
        note: 'Payment confirmed',
        changedByName: 'Maya Owner',
      });
      expect(detail.body.data.history[2]).toMatchObject({ changedByName: 'Maya Renamed' });

      const closed = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'PENDING', version: 6 });
      expect(closed.status).toBe(409);
      expect(closed.body.error).toBe('INVALID_STATUS_TRANSITION');

      const second = await createOrder(baseOrder({ customerId: fixtures.secondCustomerId }));
      const cancelled = await request(app)
        .post(`/api/orders/${second.body.data.id}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CANCELLED', version: 1 });
      expect(cancelled.status).toBe(200);

      const afterCancel = await request(app)
        .post(`/api/orders/${second.body.data.id}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 2 });
      expect(afterCancel.status).toBe(409);
      expect(afterCancel.body.error).toBe('INVALID_STATUS_TRANSITION');
    });

    // covers AC-10 and AC-12: a missing, malformed, or foreign order is a 404 before any other check
    it('returns 404 for a status change on a missing or foreign order', async () => {
      const unknown = await request(app)
        .post('/api/orders/00000000-0000-0000-0000-0000000000ff/status')
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('NOT_FOUND');

      const malformed = await request(app)
        .post('/api/orders/not-a-uuid/status')
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      expect(malformed.status).toBe(404);

      const foreign = await createOrder(
        baseOrder({
          customerId: fixtures.otherCustomerId,
          items: [{ productId: fixtures.otherProductId, quantity: 1 }],
        }),
        OUTSIDER_TOKEN,
        undefined,
        OTHER_BIZ,
      );
      expect(foreign.status).toBe(201);

      const foreignMove = await request(app)
        .post(`/api/orders/${foreign.body.data.id}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      expect(foreignMove.status).toBe(404);
      expect(foreignMove.body.error).toBe('NOT_FOUND');
    });

    // covers AC-10 and AC-17: moving to the current status fails, and status writes history but no audit row
    it('rejects a move to the current status and writes only history', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;
      const backdated = new Date('2020-01-01T00:00:00.000Z');
      await getDb().update(orders).set({ updatedAt: backdated }).where(eq(orders.id, orderId));

      const same = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'PENDING', version: 1 });
      expect(same.status).toBe(409);
      expect(same.body.error).toBe('INVALID_STATUS_TRANSITION');

      const moved = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(OWNER_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      expect(moved.status).toBe(200);
      expect(moved.body.data.version).toBe(2);
      expect(new Date(moved.body.data.updatedAt).getTime()).toBeGreaterThan(backdated.getTime());

      expect((await historyFor(orderId)).map((row) => row.toStatus)).toEqual([
        'PENDING',
        'CONFIRMED',
      ]);
      expect((await auditRowsFor(orderId)).map((row) => row.action)).toEqual(['ORDER_CREATED']);
    });
  });

  describe('concurrency (AC-2, AC-9, AC-10)', () => {
    // covers AC-2: the counter serializes concurrent creates into distinct numbers
    it('gives two concurrent creates distinct sequential numbers', async () => {
      const [left, right] = await Promise.all([
        createOrder(
          baseOrder({
            customerId: fixtures.customerId,
            items: [{ productId: fixtures.simpleProductId, quantity: 1 }],
          }),
        ),
        createOrder(
          baseOrder({
            customerId: fixtures.secondCustomerId,
            items: [
              { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 1 },
            ],
          }),
        ),
      ]);

      expect([left.status, right.status]).toEqual([201, 201]);
      expect([left.body.data.orderNumber, right.body.data.orderNumber].sort()).toEqual([
        'ORD-0001',
        'ORD-0002',
      ]);

      const counter = await getDb()
        .select()
        .from(businessOrderCounters)
        .where(eq(businessOrderCounters.businessId, BIZ));
      expect(counter[0].lastNumber).toBe(2);
    });

    // covers AC-9: the version guard lets exactly one of two same version edits write
    it('lets only one of two edits at the same version win', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;

      const [left, right] = await Promise.all([
        request(app)
          .patch(`/api/orders/${orderId}`)
          .set(as(OWNER_TOKEN))
          .send({ version: 1, notes: 'first writer' }),
        request(app)
          .patch(`/api/orders/${orderId}`)
          .set(as(OWNER_TOKEN))
          .send({ version: 1, notes: 'second writer' }),
      ]);

      expect([left.status, right.status].sort()).toEqual([200, 409]);
      const loser = left.status === 409 ? left : right;
      expect(loser.body.error).toBe('ORDER_CHANGED');

      const detail = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(detail.body.data.version).toBe(2);
      expect(['first writer', 'second writer']).toContain(detail.body.data.notes);
    });

    // covers AC-10: the version guard lets exactly one of two same version status moves write
    it('lets only one of two status changes at the same version win', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;

      const [confirmed, cancelled] = await Promise.all([
        request(app)
          .post(`/api/orders/${orderId}/status`)
          .set(as(OWNER_TOKEN))
          .send({ status: 'CONFIRMED', version: 1 }),
        request(app)
          .post(`/api/orders/${orderId}/status`)
          .set(as(OWNER_TOKEN))
          .send({ status: 'CANCELLED', version: 1 }),
      ]);

      expect([confirmed.status, cancelled.status].sort()).toEqual([200, 409]);
      const loser = confirmed.status === 409 ? confirmed : cancelled;
      expect(loser.body.error).toBe('ORDER_CHANGED');

      const detail = await request(app).get(`/api/orders/${orderId}`).set(as(OWNER_TOKEN));
      expect(detail.body.data.version).toBe(2);
      expect(detail.body.data.history).toHaveLength(2);
    });
  });

  describe('atomicity (AC-17)', () => {
    it('rolls back the counter, order, lines, history, and audit when a create fails', async () => {
      const failed = await createOrder(baseOrder(), BROKEN_TOKEN);
      expect(failed.status).toBe(500);
      expect(await countOrders()).toBe(0);

      const counters = await getDb()
        .select({ count: sql<number>`count(*)::int` })
        .from(businessOrderCounters);
      expect(Number(counters[0].count)).toBe(0);

      const items = await getDb()
        .select({ count: sql<number>`count(*)::int` })
        .from(orderItems);
      expect(Number(items[0].count)).toBe(0);
      const history = await getDb()
        .select({ count: sql<number>`count(*)::int` })
        .from(orderStatusHistory);
      expect(Number(history[0].count)).toBe(0);
      const audits = await getDb()
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLogs);
      expect(Number(audits[0].count)).toBe(0);
    });

    it('rolls back an edit and a status change when the audit actor cannot be recorded', async () => {
      const created = await createOrder(baseOrder());
      const orderId = created.body.data.id;
      const auditsBefore = await auditRowsFor(orderId);

      const failedEdit = await request(app)
        .patch(`/api/orders/${orderId}`)
        .set(as(BROKEN_TOKEN))
        .send({ version: 1, notes: 'must not stick' });
      expect(failedEdit.status).toBe(500);

      const afterEdit = await findOrder(orderId);
      expect(afterEdit).toMatchObject({ notes: null, version: 1 });
      expect(await auditRowsFor(orderId)).toHaveLength(auditsBefore.length);

      const failedStatus = await request(app)
        .post(`/api/orders/${orderId}/status`)
        .set(as(BROKEN_TOKEN))
        .send({ status: 'CONFIRMED', version: 1 });
      expect(failedStatus.status).toBe(500);

      const afterStatus = await findOrder(orderId);
      expect(afterStatus).toMatchObject({ status: 'PENDING', version: 1 });
      expect(await historyFor(orderId)).toHaveLength(1);
      expect(await auditRowsFor(orderId)).toHaveLength(auditsBefore.length);
    });
  });

  describe('repository line scoping (AC-9)', () => {
    it('never rewrites a line that belongs to another order', async () => {
      const first = await createOrder(baseOrder());
      const second = await createOrder(
        baseOrder({
          customerId: fixtures.secondCustomerId,
          items: [
            { productId: fixtures.variantProductId, variantId: fixtures.variantSId, quantity: 1 },
          ],
          confirmDuplicate: true,
        }),
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const firstLine = first.body.data.items[0];
      const secondLine = second.body.data.items[0];
      const repository = new DrizzleOrderRepository();

      await runWithContext({ userId: OWNER, businessId: BIZ, role: 'OWNER' }, async () => {
        await repository.update(
          first.body.data.id,
          first.body.data.version,
          {},
          [
            {
              id: firstLine.id,
              productId: firstLine.productId,
              variantId: firstLine.variantId,
              productNameSnapshot: firstLine.productName,
              variantLabelSnapshot: firstLine.variantLabel,
              priceSnapshot: firstLine.price,
              costSnapshot: firstLine.cost,
              quantity: 5,
              subtotal: firstLine.price * 5,
              position: 0,
            },
            {
              id: secondLine.id,
              productId: secondLine.productId,
              variantId: secondLine.variantId,
              productNameSnapshot: 'Cross order write',
              variantLabelSnapshot: secondLine.variantLabel,
              priceSnapshot: secondLine.price,
              costSnapshot: secondLine.cost,
              quantity: 99,
              subtotal: secondLine.price * 99,
              position: 1,
            },
          ],
          { businessId: BIZ, userId: OWNER, action: 'ORDER_UPDATED' },
        );
      });

      const storedFirst = await getDb()
        .select()
        .from(orderItems)
        .where(eq(orderItems.id, firstLine.id));
      const storedSecond = await getDb()
        .select()
        .from(orderItems)
        .where(eq(orderItems.id, secondLine.id));

      expect(storedFirst[0]).toMatchObject({ orderId: first.body.data.id, quantity: 5 });
      expect(storedSecond[0]).toMatchObject({
        orderId: second.body.data.id,
        productNameSnapshot: 'Panjabi',
        quantity: 1,
        subtotal: secondLine.subtotal,
      });
    });
  });
});
