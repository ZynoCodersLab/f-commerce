import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { BusinessAuditAction, BusinessAuditEntity } from '@f-commerce/contracts';
import { DrizzleBusinessRepository } from './business.repository.js';
import { getDb } from '../client.js';
import { auditLogs, businesses } from '../schema.js';
import { startPg, stopPg, resetDatabase } from '../../../../test-support/pg-test-database.js';

const BIZ = '00000000-0000-0000-0000-000000000011';
const OTHER = '00000000-0000-0000-0000-000000000012';
const MISSING = '00000000-0000-0000-0000-00000000dead';
const OWNER_USER_ID = '00000000-0000-0000-0000-0000000000aa';

const ADDRESS = {
  street: '123 Main St',
  city: 'Dhaka',
  region: 'Dhaka Division',
  postalCode: '1000',
  country: 'Bangladesh',
};

async function seedBusiness(): Promise<void> {
  await getDb()
    .insert(businesses)
    .values({
      id: BIZ,
      name: 'Test Co',
      currency: 'BDT',
      timezone: 'Europe/London',
      logoUrl: 'https://res.cloudinary.com/demo/img.png',
      address: ADDRESS,
      onboardingComplete: true,
      onboardingDraft: { name: 'Draft Co', currency: 'USD' },
    });
}

describe('DrizzleBusinessRepository', () => {
  beforeAll(async () => {
    await startPg();
  }, 60_000);

  afterAll(async () => {
    await stopPg();
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase();
    await seedBusiness();
  });

  const repository = new DrizzleBusinessRepository();

  describe('findById', () => {
    it('returns a mapped Business when the row exists', async () => {
      const result = await repository.findById(BIZ);

      expect(result).toMatchObject({
        id: BIZ,
        name: 'Test Co',
        currency: 'BDT',
        timezone: 'Europe/London',
        logoUrl: 'https://res.cloudinary.com/demo/img.png',
        address: ADDRESS,
        onboardingComplete: true,
        onboardingDraft: { name: 'Draft Co', currency: 'USD' },
      });
      expect(result?.createdAt).toBeInstanceOf(Date);
      expect(result?.updatedAt).toBeInstanceOf(Date);
    });

    it('returns null when no row is found', async () => {
      expect(await repository.findById(MISSING)).toBeNull();
    });

    it('returns null for a malformed id instead of raising a query error', async () => {
      expect(await repository.findById('not-a-uuid')).toBeNull();
    });

    it('reads a logo stored as the empty string as no logo', async () => {
      await getDb().update(businesses).set({ logoUrl: '' });

      const result = await repository.findById(BIZ);

      expect(result?.logoUrl).toBeUndefined();
    });
  });

  describe('updateProfile', () => {
    it('updates only the provided fields and returns the stored row', async () => {
      const result = await repository.updateProfile(BIZ, {
        name: 'Updated Name',
        currency: 'USD',
        timezone: 'America/New_York',
      });

      expect(result?.name).toBe('Updated Name');
      expect(result?.currency).toBe('USD');
      expect(result?.timezone).toBe('America/New_York');
      // Fields that were not provided keep their stored value.
      expect(result?.logoUrl).toBe('https://res.cloudinary.com/demo/img.png');
      expect(result?.address).toEqual(ADDRESS);
    });

    it('leaves absent fields untouched when the caller passes undefined', async () => {
      const result = await repository.updateProfile(BIZ, {
        name: 'New',
        currency: undefined,
        timezone: undefined,
        logoUrl: undefined,
        address: undefined,
        onboardingComplete: undefined,
        onboardingDraft: undefined,
      });

      expect(result?.name).toBe('New');
      expect(result?.currency).toBe('BDT');
      expect(result?.timezone).toBe('Europe/London');
      expect(result?.onboardingDraft).toEqual({ name: 'Draft Co', currency: 'USD' });
    });

    it('persists onboardingComplete and onboardingDraft when provided', async () => {
      const result = await repository.updateProfile(BIZ, {
        onboardingComplete: false,
        onboardingDraft: { name: 'Draft', currency: 'EUR' },
      });

      expect(result?.onboardingComplete).toBe(false);
      expect(result?.onboardingDraft).toEqual({ name: 'Draft', currency: 'EUR' });
    });

    it('returns null when the row is not found', async () => {
      expect(await repository.updateProfile(MISSING, { name: 'X' })).toBeNull();
    });

    // Onboarding sends '' for "no logo". The store keeps it, so the read must
    // hand back undefined: otherwise the profile answers '' where the response
    // contract allows only a URL or null.
    it('stores an empty logo as no logo and reads it back as undefined', async () => {
      const result = await repository.updateProfile(BIZ, { logoUrl: '' });

      expect(result?.logoUrl).toBeUndefined();
      expect(await repository.findById(BIZ)).toMatchObject({ logoUrl: undefined });
      const raw = await getDb().select().from(businesses);
      expect(raw[0]?.logoUrl).toBeNull();
    });

    it('applies the Asia/Dhaka database default when a new business omits timezone', async () => {
      const result = await getDb()
        .insert(businesses)
        .values({ name: 'Default Co', currency: 'BDT' })
        .returning();

      expect(result[0]?.timezone).toBe('Asia/Dhaka');
    });
  });

  describe('saveDraft', () => {
    // A draft only exists before onboarding finishes; the seeded row is complete.
    beforeEach(async () => {
      await getDb().update(businesses).set({ onboardingComplete: false });
    });

    it('merges one draft field without clearing the others', async () => {
      const saved = await repository.saveDraft(BIZ, 'name', 'Renamed Draft');

      expect(saved).toBe(true);
      const result = await repository.findById(BIZ);
      expect(result?.onboardingDraft).toEqual({ name: 'Renamed Draft', currency: 'USD' });
    });

    it('stores an address draft object', async () => {
      await repository.saveDraft(BIZ, 'address', ADDRESS);

      const result = await repository.findById(BIZ);
      expect(result?.onboardingDraft).toMatchObject({ address: ADDRESS });
    });

    it('creates the draft when the row has none', async () => {
      await getDb().update(businesses).set({ onboardingDraft: null });
      await repository.saveDraft(BIZ, 'currency', 'GBP');

      const result = await repository.findById(BIZ);
      expect(result?.onboardingDraft).toEqual({ currency: 'GBP' });
    });

    it('does not resurrect a draft once onboarding is complete', async () => {
      await repository.clearDraft(BIZ);
      await repository.updateProfile(BIZ, { onboardingComplete: true });

      // Simulates a draft request that was in flight when onboarding finished.
      const saved = await repository.saveDraft(BIZ, 'timezone', 'America/New_York');

      // A skipped write must be reported, so the route can answer 409 not 200.
      expect(saved).toBe(false);
      const result = await repository.findById(BIZ);
      expect(result?.onboardingComplete).toBe(true);
      expect(result?.onboardingDraft).toBeUndefined();
    });

    it('leaves a completed row untouched even when it still carries a draft', async () => {
      await getDb().update(businesses).set({ onboardingComplete: true });

      const saved = await repository.saveDraft(BIZ, 'timezone', 'America/New_York');

      expect(saved).toBe(false);
      const result = await repository.findById(BIZ);
      // The seeded draft is unchanged: the completed row never accepts the late write.
      expect(result?.onboardingDraft).toEqual({ name: 'Draft Co', currency: 'USD' });
    });

    it('reports false for an id that is not a UUID without writing anything', async () => {
      const saved = await repository.saveDraft('not-a-uuid', 'name', 'Ignored');

      expect(saved).toBe(false);
      const result = await repository.findById(BIZ);
      expect(result?.onboardingDraft).toEqual({ name: 'Draft Co', currency: 'USD' });
    });
  });

  describe('clearDraft', () => {
    it('unsets the onboarding draft', async () => {
      await repository.clearDraft(BIZ);

      const result = await repository.findById(BIZ);
      expect(result?.onboardingDraft).toBeUndefined();
    });
  });

  describe('tenant isolation', () => {
    it('scopes updates and drafts to the addressed business row', async () => {
      await getDb().insert(businesses).values({ id: OTHER, name: 'Other Co', currency: 'USD' });

      await repository.updateProfile(BIZ, { name: 'Renamed Co', currency: 'EUR' });
      await repository.saveDraft(OTHER, 'name', 'Other Draft');

      const mine = await repository.findById(BIZ);
      const other = await repository.findById(OTHER);

      expect(mine?.name).toBe('Renamed Co');
      expect(mine?.currency).toBe('EUR');
      expect(mine?.onboardingDraft).toEqual({ name: 'Draft Co', currency: 'USD' });
      expect(other?.name).toBe('Other Co');
      expect(other?.onboardingDraft).toEqual({ name: 'Other Draft' });
    });
  });

  describe('audit rows', () => {
    async function listAudits(businessId: string) {
      return getDb()
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.businessId, businessId))
        .orderBy(asc(auditLogs.createdAt), asc(auditLogs.action));
    }

    it('records onboarding completion and clears the draft in one transaction', async () => {
      await getDb()
        .update(businesses)
        .set({
          onboardingComplete: false,
          onboardingDraft: { name: 'Draft Co', currency: 'USD' },
        })
        .where(eq(businesses.id, BIZ));

      const updated = await repository.completeOnboarding(
        BIZ,
        {
          name: 'Launched Co',
          currency: 'USD',
          timezone: 'America/New_York',
          address: ADDRESS,
          logoUrl: 'https://res.cloudinary.com/demo/launched.png',
        },
        { userId: OWNER_USER_ID },
      );

      expect(updated?.onboardingComplete).toBe(true);
      expect(updated?.onboardingDraft).toBeUndefined();

      const rows = await listAudits(BIZ);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        businessId: BIZ,
        userId: OWNER_USER_ID,
        action: BusinessAuditAction.ONBOARDING_COMPLETED,
        entityType: BusinessAuditEntity.BUSINESS,
        entityId: BIZ,
      });
      expect(JSON.parse(rows[0]!.previousValue ?? '{}')).toMatchObject({
        name: 'Test Co',
        currency: 'BDT',
        timezone: 'Europe/London',
        onboardingComplete: false,
      });
      expect(JSON.parse(rows[0]!.newValue ?? '{}')).toMatchObject({
        name: 'Launched Co',
        currency: 'USD',
        timezone: 'America/New_York',
        logoUrl: 'https://res.cloudinary.com/demo/launched.png',
        onboardingComplete: true,
      });
    });

    it('writes profile, timezone, and logo audit rows for changed fields only', async () => {
      await repository.updateProfile(
        BIZ,
        {
          name: 'Renamed Co',
          currency: 'BDT',
          timezone: 'Asia/Dhaka',
          logoUrl: 'https://res.cloudinary.com/demo/v2.png',
        },
        { userId: OWNER_USER_ID },
      );

      const rows = await listAudits(BIZ);
      expect(rows.map((row) => row.action)).toEqual([
        BusinessAuditAction.LOGO_UPDATED,
        BusinessAuditAction.PROFILE_UPDATED,
        BusinessAuditAction.TIMEZONE_CHANGED,
      ]);

      const byAction = Object.fromEntries(rows.map((row) => [row.action, row]));
      expect(
        JSON.parse(byAction[BusinessAuditAction.PROFILE_UPDATED]!.previousValue ?? '{}'),
      ).toEqual({ name: 'Test Co' });
      expect(JSON.parse(byAction[BusinessAuditAction.PROFILE_UPDATED]!.newValue ?? '{}')).toEqual({
        name: 'Renamed Co',
      });
      expect(
        JSON.parse(byAction[BusinessAuditAction.TIMEZONE_CHANGED]!.previousValue ?? '{}'),
      ).toEqual({ timezone: 'Europe/London' });
      expect(JSON.parse(byAction[BusinessAuditAction.TIMEZONE_CHANGED]!.newValue ?? '{}')).toEqual({
        timezone: 'Asia/Dhaka',
      });
      expect(JSON.parse(byAction[BusinessAuditAction.LOGO_UPDATED]!.previousValue ?? '{}')).toEqual(
        { logoUrl: 'https://res.cloudinary.com/demo/img.png' },
      );
      expect(JSON.parse(byAction[BusinessAuditAction.LOGO_UPDATED]!.newValue ?? '{}')).toEqual({
        logoUrl: 'https://res.cloudinary.com/demo/v2.png',
      });
    });

    it('writes only BUSINESS_TIMEZONE_CHANGED when Settings sends unchanged fields with a new zone', async () => {
      await repository.updateProfile(
        BIZ,
        {
          name: 'Test Co',
          currency: 'BDT',
          address: ADDRESS,
          timezone: 'America/New_York',
        },
        { userId: OWNER_USER_ID },
      );

      const rows = await listAudits(BIZ);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe(BusinessAuditAction.TIMEZONE_CHANGED);
      expect(JSON.parse(rows[0]!.previousValue ?? '{}')).toEqual({ timezone: 'Europe/London' });
      expect(JSON.parse(rows[0]!.newValue ?? '{}')).toEqual({ timezone: 'America/New_York' });
    });

    it('writes no audit rows on a no-op save, a draft save, or a missing business', async () => {
      await repository.updateProfile(
        BIZ,
        { name: 'Test Co', currency: 'BDT', timezone: 'Europe/London', address: ADDRESS },
        { userId: OWNER_USER_ID },
      );
      await repository.updateProfile(MISSING, { name: 'Ghost' }, { userId: OWNER_USER_ID });
      await repository.completeOnboarding(
        MISSING,
        { name: 'Ghost', currency: 'BDT', timezone: 'Asia/Dhaka', address: ADDRESS },
        { userId: OWNER_USER_ID },
      );
      await getDb()
        .update(businesses)
        .set({ onboardingComplete: false })
        .where(eq(businesses.id, BIZ));
      await repository.saveDraft(BIZ, 'name', 'Draft Only');

      expect(await listAudits(BIZ)).toEqual([]);
      expect(await listAudits(MISSING)).toEqual([]);
    });
  });
});
