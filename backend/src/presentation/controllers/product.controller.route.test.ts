import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('cloudinary', () => {
  let uploadCount = 0;
  return {
    v2: {
      config: vi.fn(),
      uploader: {
        upload_stream: vi.fn(
          (
            _options: unknown,
            callback: (
              error: Error | null,
              result: { secure_url: string; public_id: string } | null,
            ) => void,
          ) => ({
            end: () => {
              uploadCount += 1;
              callback(null, {
                secure_url: `https://res.cloudinary.com/demo/image/upload/product-${uploadCount}.png`,
                public_id: `product-${uploadCount}`,
              });
            },
          }),
        ),
        destroy: vi.fn().mockResolvedValue({ result: 'ok' }),
      },
    },
  };
});

// Route tests exercise upload handlers many times in one process; the limiter
// has its own test file, so let these requests pass through.
vi.mock('../middlewares/rate-limit.middleware.js', () => ({
  uploadRateLimiter: (
    _req: import('express').Request,
    _res: import('express').Response,
    next: import('express').NextFunction,
  ) => next(),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { and, asc, eq, sql } from 'drizzle-orm';
import { categoryRouter } from './category.controller.js';
import { productRouter } from './product.controller.js';
import { config } from '../../infrastructure/config.js';
import { getDb } from '../../infrastructure/database/drizzle/client.js';
import { runWithContext } from '../../infrastructure/database/drizzle/context.js';
import {
  auditLogs,
  businesses,
  categories,
  orderItems,
  orders,
  productVariants,
  products,
} from '../../infrastructure/database/drizzle/schema.js';
import { buildProductSearchCondition } from '../../infrastructure/database/drizzle/repositories/product-search.js';
import {
  startPg,
  stopPg,
  resetDatabase,
  seedMembership,
  getTestPool,
} from '../../test-support/pg-test-database.js';

const app = express();
app.use(express.json());
app.use('/api/categories', categoryRouter);
app.use('/api/products', productRouter);

const BIZ = '00000000-0000-0000-0000-0000000000a1';
const OTHER_BIZ = '00000000-0000-0000-0000-0000000000b2';
const OWNER = '00000000-0000-0000-0000-0000000000c3';
const STAFF = '00000000-0000-0000-0000-0000000000d4';
const OUTSIDER = '00000000-0000-0000-0000-0000000000e5';
const BROKEN_AUDIT_USER = '00000000-0000-0000-0000-0000000000f6';

function tokenFor(
  userId: string,
  memberships: { businessId: string; role: 'OWNER' | 'STAFF' }[],
): string {
  return jwt.sign({ userId, memberships }, config.JWT_SECRET);
}

const OWNER_TOKEN = tokenFor(OWNER, [{ businessId: BIZ, role: 'OWNER' }]);
const STAFF_TOKEN = tokenFor(STAFF, [{ businessId: BIZ, role: 'STAFF' }]);
const OUTSIDER_TOKEN = tokenFor(OUTSIDER, [{ businessId: OTHER_BIZ, role: 'OWNER' }]);
const BROKEN_AUDIT_TOKEN = tokenFor(BROKEN_AUDIT_USER, [{ businessId: BIZ, role: 'OWNER' }]);

function as(token: string, businessId = BIZ) {
  return { authorization: `Bearer ${token}`, 'x-business-id': businessId };
}

function inBiz<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ userId: OWNER, businessId, role: 'OWNER' }, async () => await fn());
}

async function seedBusiness(businessId: string): Promise<void> {
  await getDb()
    .insert(businesses)
    .values({ id: businessId, name: `Business ${businessId}` });
}

async function createCategoryViaApi(
  name: string,
  token = OWNER_TOKEN,
  businessId = BIZ,
): Promise<string> {
  const response = await request(app)
    .post('/api/categories')
    .set(as(token, businessId))
    .send({ name });
  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

function createProductViaApi(body: Record<string, unknown>, token = OWNER_TOKEN) {
  return request(app).post('/api/products').set(as(token)).send(body);
}

type ProductApiResponse = Awaited<ReturnType<typeof createProductViaApi>>;

async function findProductRow(id: string) {
  return inBiz(BIZ, async () => {
    const result = await getDb().select().from(products).where(eq(products.id, id));
    return result[0];
  });
}

async function variantRows(productId: string) {
  return inBiz(BIZ, async () => {
    return await getDb()
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, productId));
  });
}

function indexConditions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(indexConditions);
  if (typeof value !== 'object' || value === null) return [];
  const node = value as { 'Index Cond'?: unknown; Plans?: unknown; Plan?: unknown };
  const own = typeof node['Index Cond'] === 'string' ? [node['Index Cond']] : [];
  const nested = node.Plan === undefined ? [] : indexConditions(node.Plan);
  const children = Array.isArray(node.Plans) ? node.Plans.flatMap(indexConditions) : [];
  return [...own, ...nested, ...children];
}

/**
 * Waits until the test trigger is blocked on the session lock below, which
 * proves the update transaction already holds its SKU advisory locks.
 */
async function waitForReleaseTrigger(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waiting = await getTestPool().query<{ count: string }>(`
      select count(*)::text as count
      from pg_locks
      where locktype = 'advisory' and not granted
    `);
    if (Number(waiting.rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the release trigger');
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

let orderSequence = 0;

async function seedOrderItem(productId: string): Promise<void> {
  await inBiz(BIZ, async () => {
    orderSequence += 1;
    const db = getDb();
    const inserted = await db
      .insert(orders)
      .values({
        businessId: BIZ,
        orderNumber: `ORD-${orderSequence}`,
        customerNameSnapshot: 'Snapshot customer',
        customerPhoneSnapshot: '+8801700000000',
        subtotal: 100,
        total: 100,
        dueAmount: 100,
      })
      .returning({ id: orders.id });

    await db.insert(orderItems).values({
      businessId: BIZ,
      orderId: inserted[0].id,
      productId,
      productNameSnapshot: 'Ordered product',
      priceSnapshot: 100,
      quantity: 1,
      subtotal: 100,
    });
  });
}

async function clearOrders(): Promise<void> {
  await inBiz(BIZ, async () => {
    await getDb().delete(orders).where(eq(orders.businessId, BIZ));
  });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.from('GIF89a', 'ascii');

function productBody(categoryId: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'Test Product',
    categoryId,
    price: 100,
    ...extra,
  };
}

describe('product and category routes against PostgreSQL', () => {
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
    await seedMembership(OTHER_BIZ, OUTSIDER, 'OWNER');
  });

  describe('categories (AC-3, AC-12, AC-13)', () => {
    it('creates, lists, renames, and rejects a duplicate name ignoring case', async () => {
      const created = await request(app)
        .post('/api/categories')
        .set(as(OWNER_TOKEN))
        .send({ name: '  Clothing ', description: '   ' });
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        name: 'Clothing',
        description: null,
        version: 1,
      });
      const id: string = created.body.data.id;

      const duplicate = await request(app)
        .post('/api/categories')
        .set(as(OWNER_TOKEN))
        .send({ name: 'clothing' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({
        error: 'DUPLICATE_CATEGORY',
        existingCategoryId: id,
      });

      const list = await request(app).get('/api/categories').set(as(OWNER_TOKEN));
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.data).toHaveLength(1);

      const renamed = await request(app)
        .patch(`/api/categories/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, name: 'Apparel' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toMatchObject({ name: 'Apparel', version: 2 });

      const stale = await request(app)
        .patch(`/api/categories/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, name: 'Shoes' });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('CATEGORY_CHANGED');

      const described = await request(app)
        .patch(`/api/categories/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2, description: ' Summer stock ' });
      expect(described.status).toBe(200);
      expect(described.body.data).toMatchObject({ description: 'Summer stock', version: 3 });

      const cleared = await request(app)
        .patch(`/api/categories/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 3, description: '   ' });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data).toMatchObject({ description: null, version: 4 });

      const noOp = await request(app)
        .patch(`/api/categories/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 4, description: null });
      expect(noOp.status).toBe(200);
      expect(noOp.body.data.version).toBe(4);
    });

    it('blocks delete while any live or archived product references the category', async () => {
      const categoryId = await createCategoryViaApi('Clothing');
      const createdProduct = await createProductViaApi(productBody(categoryId));
      expect(createdProduct.status).toBe(201);
      const productId: string = createdProduct.body.data.id;

      const blocked = await request(app)
        .delete(`/api/categories/${categoryId}`)
        .set(as(OWNER_TOKEN));
      expect(blocked.status).toBe(409);
      expect(blocked.body).toMatchObject({ error: 'CATEGORY_IN_USE', productCount: 1 });

      const archived = await request(app)
        .post(`/api/products/${productId}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });
      expect(archived.status).toBe(200);

      const stillBlocked = await request(app)
        .delete(`/api/categories/${categoryId}`)
        .set(as(OWNER_TOKEN));
      expect(stillBlocked.status).toBe(409);
      expect(stillBlocked.body.productCount).toBe(1);

      const deletedProduct = await request(app)
        .delete(`/api/products/${productId}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2 });
      expect(deletedProduct.status).toBe(204);

      const deletedCategory = await request(app)
        .delete(`/api/categories/${categoryId}`)
        .set(as(OWNER_TOKEN));
      expect(deletedCategory.status).toBe(204);
    });

    it('keeps categories and products inside the business', async () => {
      const categoryId = await createCategoryViaApi('Clothing');

      const otherList = await request(app)
        .get('/api/categories')
        .set(as(OUTSIDER_TOKEN, OTHER_BIZ));
      expect(otherList.status).toBe(200);
      expect(otherList.body.data).toEqual([]);

      const otherRename = await request(app)
        .patch(`/api/categories/${categoryId}`)
        .set(as(OUTSIDER_TOKEN, OTHER_BIZ))
        .send({ version: 1, name: 'Stolen' });
      expect(otherRename.status).toBe(404);

      const sameNameElsewhere = await createCategoryViaApi('Clothing', OUTSIDER_TOKEN, OTHER_BIZ);
      expect(sameNameElsewhere).not.toBe(categoryId);

      const createdProduct = await createProductViaApi(productBody(categoryId));
      expect(createdProduct.status).toBe(201);
      const productId: string = createdProduct.body.data.id;

      const otherDetail = await request(app)
        .get(`/api/products/${productId}`)
        .set(as(OUTSIDER_TOKEN, OTHER_BIZ));
      expect(otherDetail.status).toBe(404);

      const wrongCategory = await request(app)
        .post('/api/products')
        .set(as(OUTSIDER_TOKEN, OTHER_BIZ))
        .send(productBody(categoryId));
      expect(wrongCategory.status).toBe(400);
      expect(wrongCategory.body).toMatchObject({
        error: 'VALIDATION_ERROR',
        fields: ['categoryId'],
      });
    });
  });

  describe('product reads (AC-1, AC-4, AC-6, AC-7, AC-8)', () => {
    it('creates a variant product and derives product and variant statuses', async () => {
      const categoryId = await createCategoryViaApi('Tops');

      const created = await createProductViaApi(
        productBody(categoryId, {
          name: '  Oxford Shirt  ',
          description: '  Cotton  ',
          sku: '  shirt-1 ',
          price: 1200,
          cost: 800,
          stockCount: 99,
          lowStockThreshold: 2,
          options: [
            { name: ' Size ', values: [' S ', 'M'] },
            { name: 'Color', values: ['White', 'Black'] },
          ],
          variants: [
            {
              combination: { Size: 'S', Color: 'White' },
              sku: ' v-sw ',
              stockCount: 0,
              price: 1100,
            },
            { combination: { Size: 'S', Color: 'Black' }, stockCount: 5 },
            { combination: { Size: 'M', Color: 'White' }, stockCount: 1 },
            { combination: { Size: 'M', Color: 'Black' }, stockCount: 0, cost: 700 },
          ],
        }),
      );

      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        name: 'Oxford Shirt',
        description: 'Cotton',
        sku: 'SHIRT-1',
        categoryName: 'Tops',
        price: 1200,
        cost: 800,
        stockCount: 0,
        lowStockThreshold: 2,
        availableStock: 6,
        stockStatus: 'inStock',
        version: 1,
        isArchived: false,
        archivedAt: null,
      });
      expect(
        created.body.data.variants.map((entry: { stockStatus: string }) => entry.stockStatus),
      ).toEqual(['outOfStock', 'inStock', 'lowStock', 'outOfStock']);
      expect(created.body.data.variants[0]).toMatchObject({
        combination: { Size: 'S', Color: 'White' },
        sku: 'V-SW',
        price: 1100,
      });
      expect(created.body.data.variants[2].stockStatus).toBe('lowStock');

      const id: string = created.body.data.id;
      const detail = await request(app).get(`/api/products/${id}`).set(as(OWNER_TOKEN));
      expect(detail.status).toBe(200);
      expect(detail.body.data.id).toBe(id);
      expect(detail.body.data.variants).toHaveLength(4);

      const list = await request(app).get('/api/products').set(as(OWNER_TOKEN));
      expect(list.status).toBe(200);
      expect(list.body.data.items.map((item: { id: string }) => item.id)).toEqual([id]);
      expect(list.body.data.nextCursor).toBeNull();
    });

    it('searches by name and sku prefix, applies filters together, and hides archived products', async () => {
      const categoryA = await createCategoryViaApi('Tops');
      const categoryB = await createCategoryViaApi('Bottoms');

      const alpha = await createProductViaApi(
        productBody(categoryA, { name: 'Alpha Shirt', sku: 'ALP-1', stockCount: 10 }),
      );
      const beta = await createProductViaApi(
        productBody(categoryA, { name: 'Beta Shirt', sku: 'BET-1', stockCount: 0 }),
      );
      const gamma = await createProductViaApi(
        productBody(categoryB, { name: 'Gamma Pants', sku: 'GAM-1', stockCount: 2 }),
      );
      const inVariant = await createProductViaApi(
        productBody(categoryA, {
          name: 'In Variant',
          options: [{ name: 'Size', values: ['One'] }],
          variants: [{ combination: { Size: 'One' }, stockCount: 6 }],
        }),
      );
      const outVariant = await createProductViaApi(
        productBody(categoryA, {
          name: 'Out Variant',
          options: [{ name: 'Size', values: ['One'] }],
          variants: [{ combination: { Size: 'One' }, stockCount: 0 }],
        }),
      );
      const archived = await createProductViaApi(
        productBody(categoryB, { name: 'Zeta Archived', sku: 'ZET-1', stockCount: 5 }),
      );
      const archivedId: string = archived.body.data.id;
      await request(app)
        .post(`/api/products/${archivedId}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });

      expect(alpha.status).toBe(201);
      expect(beta.status).toBe(201);
      expect(gamma.status).toBe(201);
      expect(inVariant.status).toBe(201);
      expect(outVariant.status).toBe(201);
      expect(archived.status).toBe(201);

      const byName = await request(app).get('/api/products?q= alp ').set(as(OWNER_TOKEN));
      expect(byName.status).toBe(200);
      expect(byName.body.data.items.map((item: { name: string }) => item.name)).toEqual([
        'Alpha Shirt',
      ]);

      const bySku = await request(app).get('/api/products?q=bet-1').set(as(OWNER_TOKEN));
      expect(bySku.status).toBe(200);
      expect(bySku.body.data.items.map((item: { name: string }) => item.name)).toEqual([
        'Beta Shirt',
      ]);

      const containsDoesNotMatch = await request(app)
        .get('/api/products?q=shirt')
        .set(as(OWNER_TOKEN));
      expect(containsDoesNotMatch.status).toBe(200);
      expect(containsDoesNotMatch.body.data.items).toEqual([]);

      const categoryFilter = await request(app)
        .get(`/api/products?categoryId=${categoryA}`)
        .set(as(OWNER_TOKEN));
      expect(categoryFilter.status).toBe(200);
      expect(
        categoryFilter.body.data.items.map((item: { name: string }) => item.name).sort(),
      ).toEqual(['Alpha Shirt', 'Beta Shirt', 'In Variant', 'Out Variant']);

      const lowStock = await request(app)
        .get('/api/products?stockStatus=lowStock')
        .set(as(OWNER_TOKEN));
      expect(lowStock.status).toBe(200);
      expect(lowStock.body.data.items.map((item: { name: string }) => item.name)).toEqual([
        'Gamma Pants',
      ]);

      const outOfStock = await request(app)
        .get('/api/products?stockStatus=outOfStock')
        .set(as(OWNER_TOKEN));
      expect(outOfStock.status).toBe(200);
      expect(outOfStock.body.data.items.map((item: { name: string }) => item.name).sort()).toEqual([
        'Beta Shirt',
        'Out Variant',
      ]);

      const combined = await request(app)
        .get(`/api/products?categoryId=${categoryA}&stockStatus=outOfStock`)
        .set(as(OWNER_TOKEN));
      expect(combined.status).toBe(200);
      expect(combined.body.data.items.map((item: { name: string }) => item.name).sort()).toEqual([
        'Beta Shirt',
        'Out Variant',
      ]);

      const defaultList = await request(app).get('/api/products').set(as(OWNER_TOKEN));
      expect(defaultList.status).toBe(200);
      expect(defaultList.body.data.items).toHaveLength(5);

      const withArchived = await request(app)
        .get('/api/products?includeArchived=true')
        .set(as(OWNER_TOKEN));
      expect(withArchived.status).toBe(200);
      expect(withArchived.body.data.items).toHaveLength(6);
      expect(
        withArchived.body.data.items.some(
          (item: { name: string }) => item.name === 'Zeta Archived',
        ),
      ).toBe(true);

      const whitespaceSearch = await request(app)
        .get('/api/products?q=%20%20%20')
        .set(as(OWNER_TOKEN));
      expect(whitespaceSearch.status).toBe(200);
      expect(whitespaceSearch.body.data.items).toHaveLength(5);

      const repeatedFilter = await request(app)
        .get(`/api/products?categoryId=${categoryB}`)
        .set(as(OWNER_TOKEN));
      expect(repeatedFilter.status).toBe(200);
      expect(repeatedFilter.body.data.items.map((item: { name: string }) => item.name)).toEqual([
        'Gamma Pants',
      ]);
    });

    it('matches punctuation and accented names without depending on collation', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      await createProductViaApi(productBody(categoryId, { name: 'Tee Shirt' }));
      await createProductViaApi(productBody(categoryId, { name: 'Tee-Shirt' }));
      await createProductViaApi(productBody(categoryId, { name: 'Téé Shirt' }));
      await createProductViaApi(productBody(categoryId, { name: 'T-Shirt' }));
      await createProductViaApi(productBody(categoryId, { name: 'İstanbul Shirt' }));

      const plain = await request(app)
        .get('/api/products')
        .query({ q: 'Tee' })
        .set(as(OWNER_TOKEN));
      expect(plain.status).toBe(200);
      expect(plain.body.data.items.map((item: { name: string }) => item.name).sort()).toEqual([
        'Tee Shirt',
        'Tee-Shirt',
      ]);

      const accented = await request(app)
        .get('/api/products')
        .query({ q: 'TÉÉ' })
        .set(as(OWNER_TOKEN));
      expect(accented.status).toBe(200);
      expect(accented.body.data.items.map((item: { name: string }) => item.name)).toEqual([
        'Téé Shirt',
      ]);

      // JavaScript and PostgreSQL case-fold U+0130 differently; the query must
      // use PostgreSQL's lower() on both sides so the row is still found.
      const dotted = await request(app)
        .get('/api/products')
        .query({ q: 'İSTANBUL' })
        .set(as(OWNER_TOKEN));
      expect(dotted.status).toBe(200);
      expect(dotted.body.data.items.map((item: { name: string }) => item.name)).toEqual([
        'İstanbul Shirt',
      ]);
    });

    it('uses the text pattern index for the name prefix search', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      await getDb().execute(sql`
        insert into ${products} (business_id, category_id, name, sku, price)
        select ${BIZ}, ${categoryId}, 'Product ' || lpad(gs::text, 5, '0'), 'SKU-' || lpad(gs::text, 5, '0'), 100
        from generate_series(0, 19999) as gs
      `);
      await getDb().execute(sql`analyze ${products}`);

      const condition = buildProductSearchCondition('Product 04999');
      if (!condition) throw new Error('Expected a product search condition');

      // This mirrors the repository's search statement, including the left
      // join and the bound parameter values, so the plan reflects real code.
      const built = getDb()
        .select({ product: products, categoryName: categories.name })
        .from(products)
        .leftJoin(
          categories,
          and(
            eq(categories.id, products.categoryId),
            eq(categories.businessId, products.businessId),
          ),
        )
        .where(and(eq(products.businessId, BIZ), eq(products.isArchived, false), condition))
        .orderBy(sql`lower(${products.name}) asc`, asc(products.id))
        .limit(21)
        .toSQL();

      const planResult = await getTestPool().query<{ 'QUERY PLAN': unknown }>(
        `explain (format json) ${built.sql}`,
        built.params,
      );
      const plan = JSON.stringify(planResult.rows);
      // The production plan may use the collation-ordered index so LIMIT can
      // stop early. Either way the tenant scope is index backed.
      expect(plan).toContain('products_business_lower_name_idx');

      // Disable plain index scans to prove the text pattern indexes can serve
      // the same predicate as an independent, collation-safe range.
      const client = await getTestPool().connect();
      try {
        await client.query('begin');
        await client.query('set local enable_indexscan = off');
        const patternPlan = await client.query<{ 'QUERY PLAN': unknown }>(
          `explain (format json) ${built.sql}`,
          built.params,
        );
        const patternConditions = patternPlan.rows.flatMap((row) =>
          indexConditions(row['QUERY PLAN']),
        );
        expect(
          patternConditions.some(
            (value) => value.includes('lower(name) ~>=~') && value.includes('lower(name) ~<~'),
          ),
        ).toBe(true);
        expect(patternConditions.some((value) => value.includes('sku ~>=~'))).toBe(true);
        const patternText = JSON.stringify(patternPlan.rows);
        expect(patternText).toContain('products_business_lower_name_pattern_idx');
        expect(patternText).toContain('products_business_sku_pattern_idx');
      } finally {
        await client.query('rollback');
        client.release();
      }
    });

    it('pages with a cursor, clamps a large limit, and rejects a mismatched cursor', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      await inBiz(BIZ, async () => {
        await getDb()
          .insert(products)
          .values(
            Array.from({ length: 51 }, (_, index) => ({
              businessId: BIZ,
              categoryId,
              name: `Product ${String(index + 1).padStart(2, '0')}`,
              price: 100,
            })),
          );
      });

      const first = await request(app).get('/api/products?limit=100').set(as(OWNER_TOKEN));
      expect(first.status).toBe(200);
      expect(first.body.data.items).toHaveLength(50);
      expect(first.body.data.nextCursor).toEqual(expect.any(String));

      const second = await request(app)
        .get(`/api/products?limit=100&cursor=${encodeURIComponent(first.body.data.nextCursor)}`)
        .set(as(OWNER_TOKEN));
      expect(second.status).toBe(200);
      expect(second.body.data.items).toHaveLength(1);
      expect(second.body.data.nextCursor).toBeNull();

      const firstPage = await request(app)
        .get('/api/products?q=Product%200&limit=1')
        .set(as(OWNER_TOKEN));
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.data.nextCursor).toEqual(expect.any(String));

      const mismatched = await request(app)
        .get(
          `/api/products?q=Product%201&limit=1&cursor=${encodeURIComponent(
            firstPage.body.data.nextCursor,
          )}`,
        )
        .set(as(OWNER_TOKEN));
      expect(mismatched.status).toBe(400);
      expect(mismatched.body).toMatchObject({
        error: 'VALIDATION_ERROR',
        fields: ['cursor'],
      });

      const malformed = await request(app)
        .get('/api/products?cursor=not-a-cursor!')
        .set(as(OWNER_TOKEN));
      expect(malformed.status).toBe(400);
      expect(malformed.body.fields).toEqual(['cursor']);
    });
  });

  describe('product writes (AC-2, AC-9, AC-10, AC-11, AC-14)', () => {
    it('rejects duplicate skus across products and variants, including archived owners', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const first = await createProductViaApi(
        productBody(categoryId, {
          name: 'First',
          sku: 'abc',
          options: [{ name: 'Size', values: ['One'] }],
          variants: [{ combination: { Size: 'One' }, sku: 'var-1', stockCount: 1 }],
        }),
      );
      expect(first.status).toBe(201);
      const firstId: string = first.body.data.id;

      const productClash = await createProductViaApi(
        productBody(categoryId, { name: 'Second', sku: ' ABC ' }),
      );
      expect(productClash.status).toBe(409);
      expect(productClash.body).toMatchObject({
        error: 'DUPLICATE_SKU',
        existingProductId: firstId,
        existingVariantId: null,
        archived: false,
      });

      const variantClash = await createProductViaApi(
        productBody(categoryId, {
          name: 'Third',
          options: [{ name: 'Size', values: ['One'] }],
          variants: [{ combination: { Size: 'One' }, sku: 'VAR-1', stockCount: 1 }],
        }),
      );
      expect(variantClash.status).toBe(409);
      expect(variantClash.body).toMatchObject({
        error: 'DUPLICATE_SKU',
        existingProductId: firstId,
        archived: false,
      });
      expect(variantClash.body.existingVariantId).toEqual(expect.any(String));

      const archived = await request(app)
        .post(`/api/products/${firstId}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });
      expect(archived.status).toBe(200);

      const archivedClash = await createProductViaApi(
        productBody(categoryId, { name: 'Fourth', sku: 'abc' }),
      );
      expect(archivedClash.status).toBe(409);
      expect(archivedClash.body.archived).toBe(true);

      const duplicateInPayload = await createProductViaApi(
        productBody(categoryId, {
          name: 'Fifth',
          options: [{ name: 'Size', values: ['One', 'Two'] }],
          variants: [
            { combination: { Size: 'One' }, sku: 'SAME', stockCount: 1 },
            { combination: { Size: 'Two' }, sku: 'same', stockCount: 1 },
          ],
        }),
      );
      expect(duplicateInPayload.status).toBe(400);
      expect(duplicateInPayload.body).toMatchObject({
        error: 'VALIDATION_ERROR',
        fields: ['variants'],
      });

      const productVariantClash = await createProductViaApi(
        productBody(categoryId, {
          name: 'Sixth',
          sku: 'SAME',
          options: [{ name: 'Size', values: ['One'] }],
          variants: [{ combination: { Size: 'One' }, sku: 'SAME', stockCount: 1 }],
        }),
      );
      expect(productVariantClash.status).toBe(400);
      expect(productVariantClash.body.fields).toEqual(['sku']);

      const stored = await request(app)
        .get('/api/products?includeArchived=true')
        .set(as(OWNER_TOKEN));
      expect(stored.body.data.items).toHaveLength(1);
    });

    it('serializes a concurrent cross-table sku race', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const [productLevel, variantLevel] = await Promise.all([
        createProductViaApi(
          productBody(categoryId, {
            name: 'Race product',
            sku: 'RACE-SKU',
          }),
        ),
        createProductViaApi(
          productBody(categoryId, {
            name: 'Race variant',
            options: [{ name: 'Size', values: ['One'] }],
            variants: [{ combination: { Size: 'One' }, sku: 'RACE-SKU', stockCount: 1 }],
          }),
        ),
      ]);

      const responses = [productLevel, variantLevel];
      const created = responses.filter((response) => response.status === 201);
      const conflicts = responses.filter((response) => response.status === 409);
      expect(created).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].body).toMatchObject({
        error: 'DUPLICATE_SKU',
        existingProductId: created[0].body.data.id,
        archived: false,
      });
    });

    it('lets a concurrent create take a sku released by an edit', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const created = await createProductViaApi(
        productBody(categoryId, { name: 'Release source', sku: 'RELEASE-SKU' }),
      );
      const id: string = created.body.data.id;

      const hold = await getTestPool().connect();
      const pending: Promise<ProductApiResponse>[] = [];
      await hold.query('begin');
      await hold.query('select pg_advisory_lock(987654321)');
      await getTestPool().query('drop trigger if exists test_hold_release on products');
      await getTestPool().query(`
          create or replace function test_hold_release() returns trigger
          language plpgsql as $$
          begin
            perform pg_advisory_xact_lock(987654321);
            return new;
          end
          $$
        `);
      await getTestPool().query(`
          create trigger test_hold_release before update on products
          for each row execute function test_hold_release()
        `);

      try {
        const editPromise = request(app)
          .patch(`/api/products/${id}`)
          .set(as(OWNER_TOKEN))
          .send({ version: 1, sku: null });
        pending.push(editPromise);

        const raced = await Promise.race([
          waitForReleaseTrigger().then(() => 'trigger'),
          editPromise.then(
            (response) => `edit:${response.status}:${JSON.stringify(response.body)}`,
          ),
        ]);
        if (raced !== 'trigger') {
          throw new Error(`Edit resolved before reaching the trigger: ${raced}`);
        }

        pending.push(
          createProductViaApi(
            productBody(categoryId, { name: 'Release target', sku: 'RELEASE-SKU' }),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await hold.query('select pg_advisory_unlock(987654321)');
        await hold.query('commit');

        const [edit, reuse] = await Promise.all(pending);
        expect(edit.status).toBe(200);
        expect(edit.body.data.sku).toBeNull();
        expect(reuse.status).toBe(201);
        expect(reuse.body.data.sku).toBe('RELEASE-SKU');
      } finally {
        // Release the trigger before DDL, otherwise DROP TRIGGER waits on
        // the update transaction's row lock.
        try {
          await hold.query('select pg_advisory_unlock(987654321)');
        } catch {
          // Already unlocked on the happy path.
        }
        try {
          await hold.query('rollback');
        } catch {
          // The happy path already committed.
        }
        await Promise.allSettled(pending);
        await getTestPool().query('drop trigger if exists test_hold_release on products');
        await getTestPool().query('drop function if exists test_hold_release()');
        hold.release();
      }
    }, 20_000);

    it('keeps variant ids and their images when the matrix is edited', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const created = await createProductViaApi(
        productBody(categoryId, {
          name: 'Matrix',
          options: [{ name: 'Size', values: ['One', 'Two'] }],
          variants: [
            { combination: { Size: 'One' }, sku: 'SWAP-A', stockCount: 1 },
            { combination: { Size: 'Two' }, sku: 'SWAP-B', stockCount: 2 },
          ],
        }),
      );
      const id: string = created.body.data.id;
      const before = await variantRows(id);

      const image = await request(app)
        .post(`/api/products/${id}/variants/0/image`)
        .set(as(OWNER_TOKEN))
        .attach('image', PNG, { filename: 'variant.png', contentType: 'image/png' });
      expect(image.status).toBe(200);
      const imageUrl: string = image.body.data.variants[0].imageUrl;
      expect(imageUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);

      const edited = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: image.body.data.version,
          variants: [
            { combination: { Size: 'One' }, sku: 'SWAP-B', stockCount: 7 },
            { combination: { Size: 'Two' }, sku: 'SWAP-A', stockCount: 9 },
          ],
        });
      expect(edited.status).toBe(200);

      const after = await variantRows(id);
      expect(after.map((variant) => variant.id).sort()).toEqual(
        before.map((variant) => variant.id).sort(),
      );
      expect(after.find((variant) => variant.combination.Size === 'One')).toMatchObject({
        sku: 'SWAP-B',
        imageUrl,
      });
      expect(after.find((variant) => variant.combination.Size === 'Two')?.sku).toBe('SWAP-A');
    });

    it('only bumps updatedAt for variant rows whose values change', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const created = await createProductViaApi(
        productBody(categoryId, {
          name: 'Bulk Matrix',
          // Declare Color before Size: jsonb stores keys as Size then Color, so
          // a JSON.stringify comparison would see a spurious change here.
          options: [
            { name: 'Color', values: ['Red'] },
            { name: 'Size', values: ['One', 'Two'] },
          ],
          variants: [
            { combination: { Color: 'Red', Size: 'One' }, sku: 'BULK-1', stockCount: 1 },
            { combination: { Color: 'Red', Size: 'Two' }, sku: 'BULK-2', stockCount: 2 },
          ],
        }),
      );
      const id: string = created.body.data.id;
      const old = new Date('2020-01-01T00:00:00.000Z');
      await inBiz(BIZ, async () => {
        await getDb()
          .update(productVariants)
          .set({ updatedAt: old })
          .where(eq(productVariants.productId, id));
      });

      const edited = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          variants: [
            { combination: { Color: 'Red', Size: 'One' }, sku: 'BULK-1', stockCount: 7 },
            { combination: { Color: 'Red', Size: 'Two' }, sku: 'BULK-2', stockCount: 2 },
          ],
        });
      expect(edited.status).toBe(200);
      expect(edited.body.data.version).toBe(2);

      const rows = await variantRows(id);
      expect(rows.find((row) => row.sku === 'BULK-1')?.updatedAt.getTime()).toBeGreaterThan(
        old.getTime(),
      );
      expect(rows.find((row) => row.sku === 'BULK-2')?.updatedAt.getTime()).toBe(old.getTime());
    });

    it('clears a variant image when null is sent but preserves it when omitted', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const created = await createProductViaApi(
        productBody(categoryId, {
          name: 'Clearable',
          options: [{ name: 'Size', values: ['One'] }],
          variants: [{ combination: { Size: 'One' }, sku: 'CLEAR-1', stockCount: 1 }],
        }),
      );
      const id: string = created.body.data.id;

      const image = await request(app)
        .post(`/api/products/${id}/variants/0/image`)
        .set(as(OWNER_TOKEN))
        .attach('image', PNG, { filename: 'variant.png', contentType: 'image/png' });
      expect(image.status).toBe(200);
      expect(image.body.data.variants[0].imageUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);

      // Omitted imageUrl preserves the stored image, and identical values are
      // a no-op that does not bump the version.
      const omittedNoOp = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: image.body.data.version,
          variants: [{ combination: { Size: 'One' }, sku: 'CLEAR-1', stockCount: 1 }],
        });
      expect(omittedNoOp.status).toBe(200);
      expect(omittedNoOp.body.data.version).toBe(image.body.data.version);
      expect(omittedNoOp.body.data.variants[0].imageUrl).toBe(image.body.data.variants[0].imageUrl);

      const omitted = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: image.body.data.version,
          variants: [{ combination: { Size: 'One' }, sku: 'CLEAR-1', stockCount: 2 }],
        });
      expect(omitted.status).toBe(200);
      expect(omitted.body.data.variants[0].imageUrl).toBe(image.body.data.variants[0].imageUrl);

      const cleared = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: omitted.body.data.version,
          variants: [
            { combination: { Size: 'One' }, sku: 'CLEAR-1', stockCount: 2, imageUrl: null },
          ],
        });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.variants[0].imageUrl).toBeNull();
      expect((await variantRows(id))[0]?.imageUrl).toBeNull();

      // Null on an already image-less variant is also a no-op.
      const clearedNoOp = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: cleared.body.data.version,
          variants: [
            { combination: { Size: 'One' }, sku: 'CLEAR-1', stockCount: 2, imageUrl: null },
          ],
        });
      expect(clearedNoOp.status).toBe(200);
      expect(clearedNoOp.body.data.version).toBe(cleared.body.data.version);
    });

    it('edits with optimistic concurrency, clears optional text, and switches variant shape', async () => {
      const categoryA = await createCategoryViaApi('Tops');
      const categoryB = await createCategoryViaApi('Bottoms');
      const created = await createProductViaApi(
        productBody(categoryA, {
          name: 'Tee',
          description: 'Nice',
          sku: 'TEE-1',
          price: 100,
          stockCount: 3,
          lowStockThreshold: 5,
        }),
      );
      expect(created.status).toBe(201);
      const id: string = created.body.data.id;

      const noOp = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, name: ' Tee ', sku: ' tee-1 ' });
      expect(noOp.status).toBe(200);
      expect(noOp.body.data.version).toBe(1);

      const edited = await request(app).patch(`/api/products/${id}`).set(as(OWNER_TOKEN)).send({
        version: 1,
        name: 'Tee 2',
        description: '   ',
        sku: null,
        price: 120,
        stockCount: 10,
        categoryId: categoryB,
      });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({
        name: 'Tee 2',
        description: null,
        sku: null,
        price: 120,
        stockCount: 10,
        categoryName: 'Bottoms',
        stockStatus: 'inStock',
        version: 2,
      });

      const stale = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, name: 'Stale' });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('PRODUCT_CHANGED');

      const toVariant = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 2,
          stockCount: 999,
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [
            { combination: { Size: 'S' }, sku: 'TS', stockCount: 0 },
            { combination: { Size: 'M' }, sku: 'TM', stockCount: 10 },
          ],
        });
      expect(toVariant.status).toBe(200);
      expect(toVariant.body.data).toMatchObject({
        stockCount: 0,
        availableStock: 10,
        stockStatus: 'inStock',
        version: 3,
      });
      expect(
        toVariant.body.data.variants.map((entry: { stockStatus: string }) => entry.stockStatus),
      ).toEqual(['outOfStock', 'inStock']);

      const toSimple = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 3, options: [], variants: [], stockCount: 7 });
      expect(toSimple.status).toBe(200);
      expect(toSimple.body.data).toMatchObject({
        stockCount: 7,
        availableStock: 7,
        stockStatus: 'inStock',
        version: 4,
      });
      expect(toSimple.body.data.variants).toEqual([]);

      const archived = await request(app)
        .post(`/api/products/${id}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 4 });
      expect(archived.status).toBe(200);

      const archivedEdit = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1, name: 'Should not win' });
      expect(archivedEdit.status).toBe(409);
      expect(archivedEdit.body.error).toBe('PRODUCT_ARCHIVED');

      const missing = await request(app)
        .get('/api/products/00000000-0000-4000-8000-000000000000')
        .set(as(OWNER_TOKEN));
      expect(missing.status).toBe(404);

      const malformed = await request(app).get('/api/products/not-a-uuid').set(as(OWNER_TOKEN));
      expect(malformed.status).toBe(404);

      const other = await createProductViaApi(productBody(categoryA, { name: 'Other' }));
      const otherId: string = other.body.data.id;
      const invalidCategory = await request(app)
        .patch(`/api/products/${otherId}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          categoryId: '00000000-0000-4000-8000-000000000000',
        });
      expect(invalidCategory.status).toBe(400);
      expect(invalidCategory.body.fields).toEqual(['categoryId']);
    });

    it('reports DUPLICATE_SKU before an invalid variant matrix on edit (AC-9 order)', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const owner = await createProductViaApi(
        productBody(categoryId, { name: 'Owner', sku: 'DUP' }),
      );
      const target = await createProductViaApi(
        productBody(categoryId, {
          name: 'Target',
          sku: 'UNIQ',
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [
            { combination: { Size: 'S' }, sku: 'V-S', stockCount: 1 },
            { combination: { Size: 'M' }, sku: 'V-M', stockCount: 1 },
          ],
        }),
      );
      expect(owner.status).toBe(201);
      expect(target.status).toBe(201);
      const targetId: string = target.body.data.id;

      const response = await request(app)
        .patch(`/api/products/${targetId}`)
        .set(as(OWNER_TOKEN))
        .send({
          version: 1,
          sku: 'dup',
          variants: [{ combination: { Size: 'XL' }, sku: 'V-S', stockCount: 1 }],
        });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('DUPLICATE_SKU');
    });

    it('archives, restores, and hard deletes atomically with audit entries', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const created = await createProductViaApi(
        productBody(categoryId, {
          name: 'Archive Me',
          options: [{ name: 'Size', values: ['One'] }],
          variants: [{ combination: { Size: 'One' }, stockCount: 1 }],
        }),
      );
      expect(created.status).toBe(201);
      const id: string = created.body.data.id;

      const restoreActive = await request(app)
        .post(`/api/products/${id}/restore`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });
      expect(restoreActive.status).toBe(409);
      expect(restoreActive.body.error).toBe('PRODUCT_NOT_ARCHIVED');

      const deleteActive = await request(app)
        .delete(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });
      expect(deleteActive.status).toBe(409);
      expect(deleteActive.body.error).toBe('PRODUCT_NOT_ARCHIVED');

      const archived = await request(app)
        .post(`/api/products/${id}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });
      expect(archived.status).toBe(200);
      expect(archived.body.data).toMatchObject({ isArchived: true, version: 2 });
      expect(archived.body.data.archivedAt).toEqual(expect.any(String));
      expect(await auditCount(id, 'PRODUCT_ARCHIVED')).toBe(1);

      const defaultList = await request(app).get('/api/products').set(as(OWNER_TOKEN));
      expect(defaultList.body.data.items).toEqual([]);
      const allList = await request(app)
        .get('/api/products?includeArchived=true')
        .set(as(OWNER_TOKEN));
      expect(allList.body.data.items).toHaveLength(1);
      const detail = await request(app).get(`/api/products/${id}`).set(as(OWNER_TOKEN));
      expect(detail.status).toBe(200);

      const archiveAgain = await request(app)
        .post(`/api/products/${id}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 1 });
      expect(archiveAgain.status).toBe(409);
      expect(archiveAgain.body.error).toBe('PRODUCT_ARCHIVED');

      const restored = await request(app)
        .post(`/api/products/${id}/restore`)
        .set(as(OWNER_TOKEN))
        .send({ version: 2 });
      expect(restored.status).toBe(200);
      expect(restored.body.data).toMatchObject({
        isArchived: false,
        archivedAt: null,
        version: 3,
      });
      expect(await auditCount(id, 'PRODUCT_RESTORED')).toBe(1);

      const restoreAgain = await request(app)
        .post(`/api/products/${id}/restore`)
        .set(as(OWNER_TOKEN))
        .send({ version: 3 });
      expect(restoreAgain.status).toBe(409);
      expect(restoreAgain.body.error).toBe('PRODUCT_NOT_ARCHIVED');

      const archivedAgain = await request(app)
        .post(`/api/products/${id}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 3 });
      expect(archivedAgain.status).toBe(200);

      const staleDelete = await request(app)
        .delete(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 99 });
      expect(staleDelete.status).toBe(409);
      expect(staleDelete.body.error).toBe('PRODUCT_CHANGED');

      await seedOrderItem(id);
      const inUse = await request(app)
        .delete(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 4 });
      expect(inUse.status).toBe(409);
      expect(inUse.body.error).toBe('PRODUCT_IN_USE');
      expect(await findProductRow(id)).toBeDefined();
      expect(await auditCount(id, 'PRODUCT_DELETED')).toBe(0);

      await clearOrders();
      const deleted = await request(app)
        .delete(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: 4 });
      expect(deleted.status).toBe(204);
      expect(await findProductRow(id)).toBeUndefined();
      expect(await variantRows(id)).toEqual([]);
      expect(await auditCount(id, 'PRODUCT_DELETED')).toBe(1);

      const gone = await request(app).get(`/api/products/${id}`).set(as(OWNER_TOKEN));
      expect(gone.status).toBe(404);
    });

    it('rolls back the state change when the audit write fails', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const created = await createProductViaApi(productBody(categoryId, { name: 'Audit Fail' }));
      const id: string = created.body.data.id;

      // A membership whose user row is absent, so the audit write fails.
      const pool = getTestPool();
      await seedMembership(BIZ, BROKEN_AUDIT_USER, 'OWNER');
      await pool.query('ALTER TABLE "business_members" DISABLE TRIGGER ALL');
      await pool.query('DELETE FROM users WHERE id = $1', [BROKEN_AUDIT_USER]);
      await pool.query('ALTER TABLE "business_members" ENABLE TRIGGER ALL');

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const failed = await request(app)
          .post(`/api/products/${id}/archive`)
          .set(as(BROKEN_AUDIT_TOKEN))
          .send({ version: 1 });
        expect(failed.status).toBe(500);
        expect(failed.body).toEqual({
          error: 'INTERNAL_ERROR',
          message: 'The server could not complete the request.',
        });
      } finally {
        errorSpy.mockRestore();
      }

      const stored = await findProductRow(id);
      expect(stored?.isArchived).toBe(false);
      expect(stored?.version).toBe(1);
      expect(await auditCount(id)).toBe(0);
    });
  });

  describe('product images (AC-5)', () => {
    it('uploads and removes product images with magic byte, count, and size guards', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const created = await createProductViaApi(productBody(categoryId, { name: 'Photos' }));
      const id: string = created.body.data.id;

      const first = await request(app)
        .post(`/api/products/${id}/images`)
        .set(as(OWNER_TOKEN))
        .attach('images', PNG, { filename: 'one.png', contentType: 'image/png' });
      expect(first.status).toBe(200);
      expect(first.body.data.images).toHaveLength(1);
      expect(first.body.data.images[0]).toMatch(/^https:\/\/res\.cloudinary\.com\//);
      expect(first.body.data.version).toBe(2);

      const more = await request(app)
        .post(`/api/products/${id}/images`)
        .set(as(OWNER_TOKEN))
        .attach('images', PNG, { filename: 'two.png', contentType: 'image/png' })
        .attach('images', PNG, { filename: 'three.png', contentType: 'image/png' });
      expect(more.status).toBe(200);
      expect(more.body.data.images).toHaveLength(3);
      expect(more.body.data.version).toBe(3);

      const tooMany = await request(app)
        .post(`/api/products/${id}/images`)
        .set(as(OWNER_TOKEN))
        .attach('images', PNG, { filename: 'a.png', contentType: 'image/png' })
        .attach('images', PNG, { filename: 'b.png', contentType: 'image/png' })
        .attach('images', PNG, { filename: 'c.png', contentType: 'image/png' });
      expect(tooMany.status).toBe(400);
      expect(tooMany.body).toMatchObject({
        error: 'VALIDATION_ERROR',
        fields: ['images'],
      });

      const invalid = await request(app)
        .post(`/api/products/${id}/images`)
        .set(as(OWNER_TOKEN))
        .attach('images', Buffer.from('not an image'), {
          filename: 'bad.txt',
          contentType: 'image/png',
        });
      expect(invalid.status).toBe(400);
      expect(invalid.body.fields).toEqual(['images']);

      const gif = await request(app)
        .post(`/api/products/${id}/images`)
        .set(as(OWNER_TOKEN))
        .attach('images', GIF, { filename: 'bad.gif', contentType: 'image/gif' });
      expect(gif.status).toBe(400);
      expect(gif.body.fields).toEqual(['images']);

      const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
      PNG.copy(oversized);
      const tooLarge = await request(app)
        .post(`/api/products/${id}/images`)
        .set(as(OWNER_TOKEN))
        .attach('images', oversized, { filename: 'large.png', contentType: 'image/png' });
      expect(tooLarge.status).toBe(400);
      expect(tooLarge.body.fields).toEqual(['images']);

      const removed = await request(app)
        .delete(`/api/products/${id}/images/0`)
        .set(as(OWNER_TOKEN));
      expect(removed.status).toBe(200);
      expect(removed.body.data.images).toHaveLength(2);
      expect(removed.body.data.version).toBe(4);

      const outOfRange = await request(app)
        .delete(`/api/products/${id}/images/9`)
        .set(as(OWNER_TOKEN));
      expect(outOfRange.status).toBe(400);
      expect(outOfRange.body.fields).toEqual(['index']);

      await request(app)
        .post(`/api/products/${id}/archive`)
        .set(as(OWNER_TOKEN))
        .send({ version: 4 });
      const archivedUpload = await request(app)
        .post(`/api/products/${id}/images`)
        .set(as(OWNER_TOKEN))
        .attach('images', PNG, { filename: 'archived.png', contentType: 'image/png' });
      expect(archivedUpload.status).toBe(409);
      expect(archivedUpload.body.error).toBe('PRODUCT_ARCHIVED');
    });

    it('rejects a stale image write and keeps concurrent appends', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const created = await createProductViaApi(productBody(categoryId, { name: 'Concurrent' }));
      const id: string = created.body.data.id;

      const first = await request(app)
        .post(`/api/products/${id}/images`)
        .set(as(OWNER_TOKEN))
        .attach('images', PNG, { filename: 'first.png', contentType: 'image/png' });
      expect(first.status).toBe(200);
      const staleVersion = first.body.data.version;

      const renamed = await request(app)
        .patch(`/api/products/${id}`)
        .set(as(OWNER_TOKEN))
        .send({ version: staleVersion, name: 'Concurrent renamed' });
      expect(renamed.status).toBe(200);

      const stale = await request(app)
        .post(`/api/products/${id}/images`)
        .set(as(OWNER_TOKEN))
        .field('version', String(staleVersion))
        .attach('images', PNG, { filename: 'stale.png', contentType: 'image/png' });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('PRODUCT_CHANGED');

      const [left, right] = await Promise.all([
        request(app)
          .post(`/api/products/${id}/images`)
          .set(as(OWNER_TOKEN))
          .attach('images', PNG, { filename: 'left.png', contentType: 'image/png' }),
        request(app)
          .post(`/api/products/${id}/images`)
          .set(as(OWNER_TOKEN))
          .attach('images', PNG, { filename: 'right.png', contentType: 'image/png' }),
      ]);
      expect(left.status).toBe(200);
      expect(right.status).toBe(200);

      const final = await request(app).get(`/api/products/${id}`).set(as(OWNER_TOKEN));
      expect(final.status).toBe(200);
      expect(final.body.data.images).toHaveLength(3);
    });

    it('uploads one image per variant with the same guards', async () => {
      const categoryId = await createCategoryViaApi('Catalog');
      const created = await createProductViaApi(
        productBody(categoryId, {
          name: 'Variant Photos',
          options: [{ name: 'Size', values: ['One'] }],
          variants: [{ combination: { Size: 'One' }, stockCount: 1 }],
        }),
      );
      const id: string = created.body.data.id;

      const uploaded = await request(app)
        .post(`/api/products/${id}/variants/0/image`)
        .set(as(OWNER_TOKEN))
        .attach('image', PNG, { filename: 'variant.png', contentType: 'image/png' });
      expect(uploaded.status).toBe(200);
      expect(uploaded.body.data.variants[0].imageUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);
      expect(uploaded.body.data.version).toBe(2);

      const badIndex = await request(app)
        .post(`/api/products/${id}/variants/9/image`)
        .set(as(OWNER_TOKEN))
        .attach('image', PNG, { filename: 'variant.png', contentType: 'image/png' });
      expect(badIndex.status).toBe(400);
      expect(badIndex.body.fields).toEqual(['variantIndex']);
    });
  });

  describe('access control (AC-13)', () => {
    it('requires a bearer token, a membership, and allows staff', async () => {
      const anonymous = await request(app).get('/api/products');
      expect(anonymous.status).toBe(401);

      const outsider = await request(app).get('/api/products').set(as(OUTSIDER_TOKEN));
      expect(outsider.status).toBe(403);

      const categoryId = await createCategoryViaApi('Staff Catalog', STAFF_TOKEN);
      const created = await createProductViaApi(
        productBody(categoryId, { name: 'Staff Product' }),
        STAFF_TOKEN,
      );
      expect(created.status).toBe(201);
    });
  });
});
