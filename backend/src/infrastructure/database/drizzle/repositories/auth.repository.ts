import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../client.js';
import { users, businesses, businessMembers, refreshTokens } from '../schema.js';
import type { User } from '../../../../domain/entities/user.entity.js';
import { IAuthRepository } from '../../../../domain/repositories/auth.repository.js';

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash ?? undefined,
    name: row.name,
    oauth: row.oauth,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleAuthRepository implements IAuthRepository {
  /** Email is compared case insensitively, so sign in never depends on casing. */
  async findUserByEmail(email: string): Promise<User | null> {
    const result = await getDb()
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email.trim()})`);
    return result.length > 0 ? toUser(result[0]) : null;
  }

  async findUserById(userId: string): Promise<User | null> {
    const result = await getDb().select().from(users).where(eq(users.id, userId));
    return result.length > 0 ? toUser(result[0]) : null;
  }

  async createUser(userData: Partial<User>): Promise<User> {
    const result = await getDb()
      .insert(users)
      .values({
        email: normaliseEmail(userData.email ?? ''),
        name: userData.name ?? '',
        passwordHash: userData.passwordHash ?? null,
        oauth: userData.oauth ?? [],
        isActive: userData.isActive ?? true,
      })
      .returning();
    if (result.length === 0) {
      throw new Error('Failed to create user');
    }
    return toUser(result[0]);
  }

  async updateUser(userId: string, data: Partial<User>): Promise<void> {
    const changes: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (data.email !== undefined) changes.email = normaliseEmail(data.email);
    if (data.passwordHash !== undefined) changes.passwordHash = data.passwordHash;
    if (data.name !== undefined) changes.name = data.name;
    if (data.oauth !== undefined) changes.oauth = data.oauth;
    if (data.isActive !== undefined) changes.isActive = data.isActive;

    await getDb().update(users).set(changes).where(eq(users.id, userId));
  }

  async createBusiness(name: string): Promise<{ _id: string; name: string }> {
    const result = await getDb().insert(businesses).values({ name }).returning({
      _id: businesses.id,
      name: businesses.name,
    });
    if (result.length === 0) {
      throw new Error('Failed to create business');
    }
    return result[0];
  }

  async createBusinessMember(data: {
    businessId: string;
    userId: string;
    role: 'OWNER' | 'STAFF';
    status: 'ACTIVE' | 'INVITED' | 'REMOVED';
  }): Promise<void> {
    await getDb().insert(businessMembers).values({
      businessId: data.businessId,
      userId: data.userId,
      role: data.role,
      status: data.status,
    });
  }

  async findBusinessMember(businessId: string, userId: string): Promise<unknown | null> {
    const result = await getDb()
      .select()
      .from(businessMembers)
      .where(and(eq(businessMembers.businessId, businessId), eq(businessMembers.userId, userId)));
    return result.length > 0 ? result[0] : null;
  }

  /**
   * Memberships with their business, shaped like the populated documents the
   * auth service and client already expect.
   */
  async findUserBusinesses(userId: string): Promise<unknown[]> {
    const rows = await getDb()
      .select({
        id: businessMembers.id,
        role: businessMembers.role,
        status: businessMembers.status,
        businessId: businesses.id,
        businessName: businesses.name,
        currency: businesses.currency,
        logoUrl: businesses.logoUrl,
        address: businesses.address,
        onboardingComplete: businesses.onboardingComplete,
        createdAt: businesses.createdAt,
        updatedAt: businesses.updatedAt,
      })
      .from(businessMembers)
      .innerJoin(businesses, eq(businessMembers.businessId, businesses.id))
      .where(eq(businessMembers.userId, userId));

    return rows.map((row) => ({
      _id: row.id,
      role: row.role,
      status: row.status,
      businessId: {
        _id: row.businessId,
        name: row.businessName,
        currency: row.currency,
        logoUrl: row.logoUrl || null,
        address: row.address,
        onboardingComplete: row.onboardingComplete,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    }));
  }

  async createRefreshToken(userId: string, token: string, expiresAt: Date): Promise<void> {
    await getDb().insert(refreshTokens).values({ userId, token, expiresAt });
  }

  async findRefreshToken(token: string): Promise<unknown | null> {
    const result = await getDb().select().from(refreshTokens).where(eq(refreshTokens.token, token));
    return result.length > 0 ? result[0] : null;
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await getDb()
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.token, token));
  }
}
