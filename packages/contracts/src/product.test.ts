import { describe, expect, it } from 'vitest';
import {
  CategoryCreateSchema,
  imageUrlSchema,
  ProductCreateSchema,
  ProductListQuerySchema,
  ProductSchema,
  ProductUpdateSchema,
  ProductVersionSchema,
} from './index.js';

const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';

const baseProduct = {
  name: 'Tee',
  categoryId: CATEGORY_ID,
  price: 100,
};

describe('product contracts', () => {
  it('defaults the optional arrays and normalizes create text and sku', () => {
    const parsed = ProductCreateSchema.parse({
      ...baseProduct,
      name: '  Oxford Tee  ',
      description: '   ',
      sku: '  tee-1 ',
    });

    expect(parsed.name).toBe('Oxford Tee');
    expect(parsed.description).toBeUndefined();
    expect(parsed.sku).toBe('TEE-1');
    expect(parsed.images).toEqual([]);
    expect(parsed.options).toEqual([]);
    expect(parsed.variants).toEqual([]);
    expect(parsed.stockCount).toBe(0);
    expect(parsed.lowStockThreshold).toBe(5);
  });

  it('treats null optional create text as absent', () => {
    const parsed = ProductCreateSchema.parse({
      ...baseProduct,
      description: null,
      sku: null,
    });

    expect(parsed.description).toBeUndefined();
    expect(parsed.sku).toBeUndefined();
  });

  it('rejects invalid required and optional values', () => {
    expect(ProductCreateSchema.safeParse({ ...baseProduct, name: '   ' }).success).toBe(false);
    expect(ProductCreateSchema.safeParse({ ...baseProduct, price: -1 }).success).toBe(false);
    expect(ProductCreateSchema.safeParse({ ...baseProduct, price: 10.5 }).success).toBe(false);
    expect(
      ProductCreateSchema.safeParse({
        ...baseProduct,
        images: Array.from(
          { length: 6 },
          (_, index) => `https://res.cloudinary.com/demo/image/upload/${index}.png`,
        ),
      }).success,
    ).toBe(false);
  });

  it('accepts only Cloudinary secure image URLs', () => {
    expect(
      imageUrlSchema.safeParse('https://res.cloudinary.com/demo/image/upload/tee.png').success,
    ).toBe(true);
    expect(imageUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
    expect(imageUrlSchema.safeParse('data:text/html,<script>alert(1)</script>').success).toBe(
      false,
    );
    expect(imageUrlSchema.safeParse('ftp://example.com/tee.png').success).toBe(false);
    expect(imageUrlSchema.safeParse('https://evil.example/tee.png').success).toBe(false);
    expect(imageUrlSchema.safeParse('http://res.cloudinary.com/demo/tee.png').success).toBe(false);
  });

  it('measures text limits after trimming', () => {
    const description = 'a'.repeat(1000);
    const parsed = ProductCreateSchema.parse({
      ...baseProduct,
      description: `${description}   `,
    });
    expect(parsed.description).toBe(description);

    expect(
      ProductCreateSchema.safeParse({ ...baseProduct, description: 'a'.repeat(1001) }).success,
    ).toBe(false);
  });

  it('distinguishes an omitted edit field from a cleared one', () => {
    const omitted = ProductUpdateSchema.parse({ version: 1 });
    expect(omitted.description).toBeUndefined();
    expect(omitted.sku).toBeUndefined();

    const cleared = ProductUpdateSchema.parse({
      version: 1,
      description: '   ',
      sku: null,
    });
    expect(cleared.description).toBeNull();
    expect(cleared.sku).toBeNull();

    const renamed = ProductUpdateSchema.parse({ version: 1, sku: ' ab-2 ' });
    expect(renamed.sku).toBe('AB-2');
  });

  it('keeps a null variant image as an explicit clear and an omitted one as preserve', () => {
    const baseVariant = { combination: { Size: 'One' }, sku: 'CLEAR-1', stockCount: 1 };

    const omitted = ProductUpdateSchema.parse({ version: 1, variants: [baseVariant] });
    expect(omitted.variants?.[0]?.imageUrl).toBeUndefined();

    const cleared = ProductUpdateSchema.parse({
      version: 1,
      variants: [
        {
          ...baseVariant,
          imageUrl: null,
        },
      ],
    });
    expect(cleared.variants?.[0]?.imageUrl).toBeNull();
  });

  it('requires a whole version of at least 1 for edits and transitions', () => {
    expect(ProductUpdateSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(ProductUpdateSchema.safeParse({ version: 1.5 }).success).toBe(false);
    expect(ProductVersionSchema.safeParse({ version: 2 }).success).toBe(true);
    expect(ProductVersionSchema.safeParse({}).success).toBe(false);
  });

  it('parses list filters, booleans, and a numeric limit string', () => {
    const parsed = ProductListQuerySchema.parse({
      q: ' tee ',
      categoryId: CATEGORY_ID,
      stockStatus: 'lowStock',
      includeArchived: 'true',
      limit: '100',
    });
    expect(parsed).toMatchObject({
      q: ' tee ',
      categoryId: CATEGORY_ID,
      stockStatus: 'lowStock',
      includeArchived: true,
      limit: '100',
    });

    const defaults = ProductListQuerySchema.parse({});
    expect(defaults.includeArchived).toBe(false);

    expect(ProductListQuerySchema.safeParse({ limit: 'ten' }).success).toBe(false);
    expect(ProductListQuerySchema.safeParse({ stockStatus: 'many' }).success).toBe(false);
    expect(ProductListQuerySchema.safeParse({ categoryId: 'not-a-uuid' }).success).toBe(false);
  });

  // covers the response contract: timestamps stay ISO strings, so reject a
  // stored value that would not survive JSON date serialization
  it('rejects product timestamps that are not ISO 8601', () => {
    const product = {
      id: 'product-1',
      name: 'Tee',
      description: null,
      categoryId: CATEGORY_ID,
      categoryName: 'Shirts',
      sku: null,
      price: 100,
      cost: null,
      stockCount: 5,
      lowStockThreshold: 2,
      availableStock: 5,
      stockStatus: 'inStock',
      images: [],
      options: [],
      variants: [],
      isArchived: false,
      archivedAt: null,
      version: 1,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    };

    expect(ProductSchema.safeParse(product).success).toBe(true);
    expect(ProductSchema.safeParse({ ...product, createdAt: '2026-10-20' }).success).toBe(false);
    expect(ProductSchema.safeParse({ ...product, updatedAt: 'not-a-date' }).success).toBe(false);
    expect(ProductSchema.safeParse({ ...product, archivedAt: '2026-10-20' }).success).toBe(false);
  });

  it('trims category names and treats a blank description as absent', () => {
    const parsed = CategoryCreateSchema.parse({ name: '  Clothing ', description: '  ' });
    expect(parsed.name).toBe('Clothing');
    expect(parsed.description).toBeUndefined();
  });
});
