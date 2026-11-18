import { z } from 'zod';

import { IsoDateTimeSchema } from './datetime.js';

// Re-declare StockStatus enum in contracts for frontend use without importing backend
export const ProductStockStatus = {
  IN_STOCK: 'inStock',
  LOW_STOCK: 'lowStock',
  OUT_OF_STOCK: 'outOfStock',
} as const;
export type ProductStockStatus = (typeof ProductStockStatus)[keyof typeof ProductStockStatus];

/** Action codes recorded when a product's state changes. */
export const ProductAuditAction = {
  ARCHIVED: 'PRODUCT_ARCHIVED',
  RESTORED: 'PRODUCT_RESTORED',
  DELETED: 'PRODUCT_DELETED',
} as const;

/** Error codes returned by the product endpoints. */
export const ProductErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DUPLICATE_SKU: 'DUPLICATE_SKU',
  PRODUCT_CHANGED: 'PRODUCT_CHANGED',
  PRODUCT_ARCHIVED: 'PRODUCT_ARCHIVED',
  PRODUCT_NOT_ARCHIVED: 'PRODUCT_NOT_ARCHIVED',
  PRODUCT_IN_USE: 'PRODUCT_IN_USE',
} as const;

/** Error codes returned by the category endpoints. */
export const CategoryErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  DUPLICATE_CATEGORY: 'DUPLICATE_CATEGORY',
  CATEGORY_CHANGED: 'CATEGORY_CHANGED',
  CATEGORY_IN_USE: 'CATEGORY_IN_USE',
} as const;

export type ProductErrorCodeType = (typeof ProductErrorCode)[keyof typeof ProductErrorCode];
export type CategoryErrorCodeType = (typeof CategoryErrorCode)[keyof typeof CategoryErrorCode];

// --- Helper transforms ---

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_CATEGORY_NAME_LENGTH = 80;
const MAX_CATEGORY_DESCRIPTION_LENGTH = 500;
const MAX_OPTION_NAME_LENGTH = 30;
const MAX_OPTION_VALUE_LENGTH = 30;
const MAX_VALUES_PER_OPTION = 20;
const MAX_OPTIONS = 3;
const MAX_VARIANTS = 50;
const MAX_IMAGES = 5;

/** Create treats omitted, null, and blank optional text the same way: absent. */
function createOptionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) return undefined;
      return value === '' ? undefined : value;
    });
}

/**
 * Edit keeps omitted fields unchanged, while null or blank clears the field.
 * The transform maps omitted to undefined and clearing to null so the two are
 * told apart downstream.
 */
function editOptionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      return value === '' ? null : value;
    });
}

/** SKU is stored trimmed and uppercased; a blank SKU on create is absent. */
function createSku() {
  return z
    .string()
    .nullable()
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) return undefined;
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed.toUpperCase();
    });
}

/** An omitted SKU is unchanged; null or blank clears it. */
function editSku() {
  return z
    .string()
    .nullable()
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed.toUpperCase();
    });
}

const CLOUDINARY_IMAGE_HOST = 'res.cloudinary.com';

/**
 * Product and variant images are Cloudinary secure URLs. A plain URL check is
 * not enough: it also accepts javascript:, data:, ftp:, and arbitrary hosts.
 */
export const imageUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === CLOUDINARY_IMAGE_HOST;
  } catch {
    return false;
  }
}, 'Image URL must be a Cloudinary secure URL');
const priceSchema = z
  .number()
  .int('Price must be a whole number')
  .min(0, 'Price must be at least 0');
const costSchema = z.number().int('Cost must be a whole number').min(0, 'Cost must be at least 0');

// --- Category DTOs ---

export const CategoryCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(MAX_CATEGORY_NAME_LENGTH, `Name must be ${MAX_CATEGORY_NAME_LENGTH} characters or fewer`),
  description: createOptionalText(MAX_CATEGORY_DESCRIPTION_LENGTH),
});

export const CategoryUpdateSchema = z.object({
  version: z.number().int().min(1),
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(MAX_CATEGORY_NAME_LENGTH, `Name must be ${MAX_CATEGORY_NAME_LENGTH} characters or fewer`)
    .optional(),
  description: editOptionalText(MAX_CATEGORY_DESCRIPTION_LENGTH),
});

export const CategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  version: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const CategoryListSchema = z.array(CategorySchema);

export const DuplicateCategoryErrorSchema = z.object({
  error: z.literal(CategoryErrorCode.DUPLICATE_CATEGORY),
  message: z.string(),
  existingCategoryId: z.string(),
});

export const CategoryChangedErrorSchema = z.object({
  error: z.literal(CategoryErrorCode.CATEGORY_CHANGED),
  message: z.string(),
});

export const CategoryInUseErrorSchema = z.object({
  error: z.literal(CategoryErrorCode.CATEGORY_IN_USE),
  message: z.string(),
  productCount: z.number().int(),
});

export type CategoryCreateRequest = z.infer<typeof CategoryCreateSchema>;
export type CategoryUpdateRequest = z.infer<typeof CategoryUpdateSchema>;
export type CategoryDto = z.infer<typeof CategorySchema>;
export type DuplicateCategoryError = z.infer<typeof DuplicateCategoryErrorSchema>;
export type CategoryChangedError = z.infer<typeof CategoryChangedErrorSchema>;
export type CategoryInUseError = z.infer<typeof CategoryInUseErrorSchema>;

// --- Product DTOs ---

// The variants array is a full replacement: every listed entry describes the
// complete desired row, so an omitted sku clears that variant's sku. imageUrl
// is managed separately: null clears it and omission keeps the stored image.
const VariantSchema = z.object({
  combination: z.record(z.string(), z.string()),
  sku: createSku(),
  price: priceSchema.optional(),
  cost: costSchema.optional(),
  stockCount: z.number().int().min(0),
  // null clears an existing variant image; omission preserves it.
  imageUrl: imageUrlSchema.nullable().optional(),
});

const OptionSchema = z.object({
  name: z.string().trim().min(1).max(MAX_OPTION_NAME_LENGTH),
  values: z
    .array(z.string().trim().min(1).max(MAX_OPTION_VALUE_LENGTH))
    .min(1, `Each option must have at least 1 value`)
    .max(MAX_VALUES_PER_OPTION, `Each option may have at most ${MAX_VALUES_PER_OPTION} values`),
});

export const ProductCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(MAX_NAME_LENGTH, `Name must be ${MAX_NAME_LENGTH} characters or fewer`),
  description: createOptionalText(MAX_DESCRIPTION_LENGTH),
  categoryId: z.string().min(1, 'Category is required'),
  sku: createSku(),
  price: priceSchema,
  cost: costSchema.optional(),
  stockCount: z.number().int().min(0).default(0),
  lowStockThreshold: z.number().int().min(0).default(5),
  images: z
    .array(imageUrlSchema)
    .max(MAX_IMAGES, `At most ${MAX_IMAGES} images are allowed`)
    .default([]),
  options: z
    .array(OptionSchema)
    .max(MAX_OPTIONS, `At most ${MAX_OPTIONS} options are allowed`)
    .default([]),
  variants: z
    .array(VariantSchema)
    .max(MAX_VARIANTS, `At most ${MAX_VARIANTS} variants are allowed`)
    .default([]),
});

export const ProductUpdateSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  description: editOptionalText(MAX_DESCRIPTION_LENGTH),
  categoryId: z.string().min(1).optional(),
  sku: editSku(),
  price: priceSchema.optional(),
  cost: costSchema.optional(),
  stockCount: z.number().int().min(0).optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  images: z
    .array(imageUrlSchema)
    .max(MAX_IMAGES, `At most ${MAX_IMAGES} images are allowed`)
    .optional(),
  options: z
    .array(OptionSchema)
    .max(MAX_OPTIONS, `At most ${MAX_OPTIONS} options are allowed`)
    .optional(),
  variants: z
    .array(VariantSchema)
    .max(MAX_VARIANTS, `At most ${MAX_VARIANTS} variants are allowed`)
    .optional(),
});

/** Query string for GET /api/products. Values arrive as strings from Express. */
export const ProductListQuerySchema = z.object({
  q: z.string().optional(),
  categoryId: z.string().uuid('Category id must be a UUID').optional(),
  stockStatus: z.enum(['inStock', 'lowStock', 'outOfStock']).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  limit: z.string().regex(/^\d+$/, 'Limit must be a whole number').optional(),
  cursor: z.string().optional(),
});

/** Body for archive, restore, and hard delete. */
export const ProductVersionSchema = z.object({
  version: z.number().int().min(1),
});

export const VariantDtoSchema = z.object({
  /** Persisted variant id, used to reference the variant when creating an order. */
  id: z.string().optional(),
  combination: z.record(z.string(), z.string()),
  sku: z.string().nullable(),
  price: z.number().nullable(),
  cost: z.number().nullable(),
  stockCount: z.number().int(),
  imageUrl: z.string().nullable(),
  stockStatus: z.enum(['inStock', 'lowStock', 'outOfStock']),
});

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  categoryId: z.string(),
  categoryName: z.string().nullable(),
  sku: z.string().nullable(),
  price: z.number(),
  cost: z.number().nullable(),
  stockCount: z.number().int(),
  lowStockThreshold: z.number().int(),
  availableStock: z.number().int(),
  stockStatus: z.enum(['inStock', 'lowStock', 'outOfStock']),
  images: z.array(z.string()),
  options: z.array(
    z.object({
      name: z.string(),
      values: z.array(z.string()),
    }),
  ),
  variants: z.array(VariantDtoSchema),
  isArchived: z.boolean(),
  archivedAt: IsoDateTimeSchema.nullable(),
  version: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const ProductPageSchema = z.object({
  items: z.array(ProductSchema),
  nextCursor: z.string().nullable(),
});

export const DuplicateSkuErrorSchema = z.object({
  error: z.literal(ProductErrorCode.DUPLICATE_SKU),
  message: z.string(),
  existingProductId: z.string(),
  existingVariantId: z.string().nullable(),
  archived: z.boolean(),
});

export const ProductChangedErrorSchema = z.object({
  error: z.literal(ProductErrorCode.PRODUCT_CHANGED),
  message: z.string(),
});

export const ProductArchivedErrorSchema = z.object({
  error: z.literal(ProductErrorCode.PRODUCT_ARCHIVED),
  message: z.string(),
});

export const ProductNotArchivedErrorSchema = z.object({
  error: z.literal(ProductErrorCode.PRODUCT_NOT_ARCHIVED),
  message: z.string(),
});

export const ProductInUseErrorSchema = z.object({
  error: z.literal(ProductErrorCode.PRODUCT_IN_USE),
  message: z.string(),
});

export type ProductCreateRequest = z.infer<typeof ProductCreateSchema>;
export type ProductUpdateRequest = z.infer<typeof ProductUpdateSchema>;
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>;
export type ProductVersionRequest = z.infer<typeof ProductVersionSchema>;
export type ProductDto = z.infer<typeof ProductSchema>;
export type ProductPageDto = z.infer<typeof ProductPageSchema>;
export type VariantDto = z.infer<typeof VariantDtoSchema>;
export type ProductAuditActionType = (typeof ProductAuditAction)[keyof typeof ProductAuditAction];
export type DuplicateSkuError = z.infer<typeof DuplicateSkuErrorSchema>;
export type ProductChangedError = z.infer<typeof ProductChangedErrorSchema>;
export type ProductArchivedError = z.infer<typeof ProductArchivedErrorSchema>;
export type ProductNotArchivedError = z.infer<typeof ProductNotArchivedErrorSchema>;
export type ProductInUseError = z.infer<typeof ProductInUseErrorSchema>;
