import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from '../infrastructure/database/drizzle/schema.js';
import { businesses, businessMembers, users } from '../infrastructure/database/drizzle/schema.js';
import { setTestDb, resetTestDb } from '../infrastructure/database/drizzle/client.js';
import type { DbType } from '../infrastructure/database/drizzle/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(HERE, '..', '..', 'drizzle', 'migrations');

/**
 * Integration tests run against a real PostgreSQL database so transactions,
 * partial and expression indexes, and constraints behave exactly like
 * production. The database is created on first use and truncated between
 * tests. Test files run serially (see vitest.config.ts) so they can share it.
 *
 * Resolution order: TEST_DATABASE_URL, then DATABASE_URL with a "-test"
 * suffix, then the local development default.
 */
function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const base = process.env.DATABASE_URL;
  if (base) {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}-test`;
    return url.toString();
  }
  return 'postgresql://postgres:local@localhost:5432/f-commerce-test';
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function ensureDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (databaseName === '') {
    throw new Error('Test database URL must include a database name');
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString() });
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    }
  } finally {
    await admin.end();
  }
}

let pool: Pool | null = null;
let drizzleDb: DbType | null = null;

/** Create the test database if needed, apply migrations, and install it as the active handle. */
export async function startPg(): Promise<DbType> {
  const url = testDatabaseUrl();
  await ensureDatabase(url);

  pool = new Pool({ connectionString: url });
  drizzleDb = drizzle(pool, { schema });
  await migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });
  setTestDb(drizzleDb);
  return drizzleDb;
}

export async function stopPg(): Promise<void> {
  resetTestDb();
  if (pool) {
    await pool.end();
    pool = null;
  }
  drizzleDb = null;
}

/** Empty every public table between tests, restarting identity and cascading. */
export async function resetDatabase(): Promise<void> {
  if (!pool) throw new Error('Postgres test database is not started');

  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = result.rows.map((row) => quoteIdentifier(row.tablename)).join(', ');
  if (tables !== '') {
    await pool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  }
}

/**
 * Store the user and membership rows that the auth middleware reads on every
 * business request. Route tests sign their own tokens, so without these rows
 * every request would be refused with BUSINESS_ACCESS_DENIED.
 */
export async function seedMembership(
  businessId: string,
  userId: string,
  role: 'OWNER' | 'STAFF',
  options: { status?: 'ACTIVE' | 'INVITED' | 'REMOVED' } = {},
): Promise<void> {
  if (!drizzleDb) throw new Error('Postgres test database is not started');

  await drizzleDb
    .insert(businesses)
    .values({ id: businessId, name: `Business ${businessId}` })
    .onConflictDoNothing();
  await drizzleDb
    .insert(users)
    .values({ id: userId, email: `${userId}@example.com`, name: `User ${userId.slice(0, 8)}` })
    .onConflictDoNothing();
  await drizzleDb
    .insert(businessMembers)
    .values({ businessId, userId, role, status: options.status ?? 'ACTIVE' })
    .onConflictDoNothing();
}

export function getTestDb(): DbType {
  if (!drizzleDb) throw new Error('Postgres test database is not started');
  return drizzleDb;
}

/** Run raw SQL against the test pool, for seeding fixtures. */
export function getTestPool(): Pool {
  if (!pool) throw new Error('Postgres test database is not started');
  return pool;
}
