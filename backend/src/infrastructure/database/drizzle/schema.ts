import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  date,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { Address, Business } from '../../../domain/entities/business.entity.js';
import type { OrderStatus } from '../../../domain/entities/order.entity.js';
import type { PaymentMethod } from '../../../domain/entities/financial.entity.js';
import type { InventoryTransactionType } from '../../../domain/entities/inventory.entity.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('BDT'),
  timezone: text('timezone').notNull().default('Asia/Dhaka'),
  logoUrl: text('logo_url'),
  address: jsonb('address').$type<Address>(),
  onboardingComplete: boolean('onboarding_complete').notNull().default(false),
  onboardingDraft: jsonb('onboarding_draft').$type<Business['onboardingDraft']>(),
  ...timestamps,
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The original case sensitive unique constraint is kept for migration
    // history. Identity is case insensitive now, enforced by the lower index
    // below; the two constraints agree for every email that differs by more
    // than letter case.
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash'),
    name: text('name').notNull(),
    oauth: jsonb('oauth').$type<{ provider: string; providerId: string }[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    // Email identity is case insensitive (AC-18), so two accounts can never
    // differ only by letter case.
    uniqueIndex('users_email_lower_unq').on(sql`lower(${table.email})`),
  ],
);

export const businessMembers = pgTable(
  'business_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    // ACTIVE, REMOVED, or INVITED (legacy rows only; the migration deletes them).
    status: text('status').notNull().default('ACTIVE'),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('business_members_business_user_unq').on(table.businessId, table.userId),
    index('business_members_business_status_idx').on(table.businessId, table.status),
    index('business_members_user_status_idx').on(table.userId, table.status),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').notNull().default('STAFF'),
    // SHA 256 hex of the 32 random bytes handed out once. The raw token is
    // never stored (AC-20).
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
    emailStatus: text('email_status').notNull().default('QUEUED'),
    emailAttempts: integer('email_attempts').notNull().default(0),
    lastEmailError: text('last_email_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('invitations_token_hash_unq').on(table.tokenHash),
    index('invitations_business_email_idx').on(table.businessId, table.email),
    // One live invite per business and email (AC-11).
    uniqueIndex('invitations_business_email_live_unq')
      .on(table.businessId, sql`lower(${table.email})`)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    index('invitations_business_expires_idx').on(table.businessId, table.expiresAt),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('refresh_tokens_expires_at_idx').on(table.expiresAt)],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    email: text('email'),
    address: text('address'),
    notes: text('notes'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('customers_business_phone_unq').on(table.businessId, table.phone),
    // Case-insensitive name sort and prefix search.
    index('customers_business_lower_name_idx').on(table.businessId, sql`lower(${table.name})`),
    index('customers_business_archived_name_idx').on(
      table.businessId,
      table.archivedAt,
      table.name,
    ),
  ],
);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    name: text('name').notNull(),
    description: text('description'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    // Case-insensitive unique name per business (AC-3).
    uniqueIndex('categories_business_name_lower_unq').on(
      table.businessId,
      sql`lower(${table.name})`,
    ),
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    description: text('description'),
    sku: text('sku'),
    price: integer('price').notNull(),
    cost: integer('cost'),
    stockCount: integer('stock_count').notNull().default(0),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
    images: text('images').array().notNull().default([]),
    options: jsonb('options').$type<{ name: string; values: string[] }[]>().notNull().default([]),
    isArchived: boolean('is_archived').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    // Product level SKU is unique per business across archived products too.
    uniqueIndex('products_business_sku_unq')
      .on(table.businessId, table.sku)
      .where(sql`${table.sku} IS NOT NULL`),
    index('products_business_lower_name_idx').on(table.businessId, sql`lower(${table.name})`),
    // Pattern indexes make LIKE prefix search collation independent. The
    // default-collation index above still serves ORDER BY lower(name).
    index('products_business_lower_name_pattern_idx').on(
      table.businessId,
      sql`lower(${table.name}) text_pattern_ops`,
    ),
    index('products_business_sku_pattern_idx')
      .on(table.businessId, sql`${table.sku} text_pattern_ops`)
      .where(sql`${table.sku} IS NOT NULL`),
    index('products_business_category_idx').on(table.businessId, table.categoryId),
    index('products_business_archived_name_idx').on(table.businessId, table.isArchived, table.name),
  ],
);

export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    combination: jsonb('combination').$type<Record<string, string>>().notNull(),
    sku: text('sku'),
    price: integer('price'),
    cost: integer('cost'),
    stockCount: integer('stock_count').notNull().default(0),
    imageUrl: text('image_url'),
    position: integer('position').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('product_variants_product_position_unq').on(table.productId, table.position),
    // Variant SKU is unique per business across archived products too.
    uniqueIndex('product_variants_business_sku_unq')
      .on(table.businessId, table.sku)
      .where(sql`${table.sku} IS NOT NULL`),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    orderNumber: text('order_number').notNull(),
    status: text('status')
      .$type<OrderStatus>()
      .notNull()
      .default('PENDING' as OrderStatus),
    customerNameSnapshot: text('customer_name_snapshot').notNull(),
    customerPhoneSnapshot: text('customer_phone_snapshot').notNull(),
    subtotal: integer('subtotal').notNull(),
    deliveryFee: integer('delivery_fee').notNull().default(0),
    discount: integer('discount').notNull().default(0),
    total: integer('total').notNull(),
    paidAmount: integer('paid_amount').notNull().default(0),
    dueAmount: integer('due_amount').notNull(),
    shippingAddress: text('shipping_address'),
    courierId: uuid('courier_id'),
    trackingNumber: text('tracking_number'),
    source: text('source'),
    notes: text('notes'),
    // A promise is a day, not a moment. String mode keeps it a YYYY-MM-DD
    // value so it never becomes a Date and never shifts by timezone.
    deliveryDeadline: date('delivery_deadline', { mode: 'string' }),
    idempotencyKey: text('idempotency_key'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('orders_business_order_number_unq').on(table.businessId, table.orderNumber),
    uniqueIndex('orders_business_idempotency_key_unq')
      .on(table.businessId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index('orders_business_customer_created_idx').on(
      table.businessId,
      table.customerId,
      table.createdAt,
      table.id,
    ),
    index('orders_business_status_created_idx').on(
      table.businessId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index('orders_business_created_idx').on(table.businessId, table.createdAt, table.id),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
    productNameSnapshot: text('product_name_snapshot').notNull(),
    variantLabelSnapshot: text('variant_label_snapshot'),
    priceSnapshot: integer('price_snapshot').notNull(),
    costSnapshot: integer('cost_snapshot').notNull().default(0),
    quantity: integer('quantity').notNull(),
    subtotal: integer('subtotal').notNull(),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index('order_items_order_idx').on(table.orderId),
    // Supports the product hard delete guard: has this product ever been ordered?
    index('order_items_business_product_idx').on(table.businessId, table.productId),
  ],
);

export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status').$type<OrderStatus>(),
    toStatus: text('to_status').$type<OrderStatus>().notNull(),
    note: text('note'),
    changedByUserId: uuid('changed_by_user_id').notNull(),
    changedByName: text('changed_by_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('order_status_history_business_order_created_idx').on(
      table.businessId,
      table.orderId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const businessOrderCounters = pgTable('business_order_counters', {
  businessId: uuid('business_id')
    .primaryKey()
    .references(() => businesses.id),
  lastNumber: integer('last_number').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    userId: uuid('user_id').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    previousValue: text('previous_value'),
    newValue: text('new_value'),
    metadata: text('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_business_entity_idx').on(table.businessId, table.entityType, table.entityId),
    index('audit_logs_business_entity_created_idx').on(
      table.businessId,
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    index('audit_logs_business_user_idx').on(table.businessId, table.userId),
    // Retention sweep support; rows older than 365 days are deleted by a job.
    index('audit_logs_created_at_idx').on(table.createdAt),
  ],
);

export const couriers = pgTable('couriers', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  name: text('name').notNull(),
  contactNumber: text('contact_number'),
  trackingUrlTemplate: text('tracking_url_template'),
  ...timestamps,
});

export const inventoryTransactions = pgTable(
  'inventory_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    type: text('type').$type<InventoryTransactionType>().notNull(),
    quantity: integer('quantity').notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    reason: text('reason'),
    ...timestamps,
  },
  (table) => [
    index('inventory_transactions_business_product_idx').on(table.businessId, table.productId),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    amount: integer('amount').notNull(),
    method: text('method').$type<PaymentMethod>().notNull(),
    referenceNumber: text('reference_number'),
    notes: text('notes'),
    paymentDate: timestamp('payment_date', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [index('payments_business_order_idx').on(table.businessId, table.orderId)],
);

export const expenseCategories = pgTable('expense_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  name: text('name').notNull(),
  description: text('description'),
  ...timestamps,
});

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    categoryId: uuid('category_id').references(() => expenseCategories.id, {
      onDelete: 'set null',
    }),
    amount: integer('amount').notNull(),
    date: timestamp('date', { withTimezone: true }).notNull().defaultNow(),
    referenceNumber: text('reference_number'),
    notes: text('notes'),
    ...timestamps,
  },
  (table) => [index('expenses_business_date_idx').on(table.businessId, table.date)],
);
