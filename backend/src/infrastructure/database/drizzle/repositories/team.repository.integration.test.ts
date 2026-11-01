import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { DrizzleTeamRepository } from './team.repository.js';
import { getDb } from '../client.js';
import {
  startPg,
  stopPg,
  resetDatabase,
  seedMembership,
} from '../../../../test-support/pg-test-database.js';
import { auditLogs, businesses, invitations, users } from '../schema.js';
import { hashInviteToken } from '../../../../domain/invitation-token.js';
import type { InvitationRole } from '../../../../domain/entities/invitation.entity.js';

const BIZ = '00000000-0000-0000-0000-0000000000a1';
const OTHER_BIZ = '00000000-0000-0000-0000-0000000000a2';
const OWNER = '00000000-0000-0000-0000-0000000000b1';
const STAFF = '00000000-0000-0000-0000-0000000000b2';
const NEWCOMER = '00000000-0000-0000-0000-0000000000b3';

const repo = new DrizzleTeamRepository();

function later(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function auditRows(entityId: string) {
  return getDb()
    .select({ action: auditLogs.action, entityType: auditLogs.entityType })
    .from(auditLogs)
    .where(and(eq(auditLogs.businessId, BIZ), eq(auditLogs.entityId, entityId)))
    .orderBy(auditLogs.createdAt);
}

async function seedInvitation(
  email: string,
  extra: { role?: InvitationRole; token?: string; status?: 'live' | 'accepted' | 'revoked' } = {},
): Promise<string> {
  const token = extra.token ?? `token-${Math.random().toString(36).slice(2)}`;
  const status = extra.status ?? 'live';
  const rows = await getDb()
    .insert(invitations)
    .values({
      businessId: BIZ,
      email,
      role: extra.role ?? 'STAFF',
      tokenHash: hashInviteToken(token),
      invitedByUserId: OWNER,
      expiresAt: later(7),
      acceptedAt: status === 'accepted' ? new Date() : null,
      revokedAt: status === 'revoked' ? new Date() : null,
    })
    .returning({ id: invitations.id });
  return rows[0].id;
}

async function membership(userId: string) {
  const rows = await getDb()
    .select()
    .from((await import('../schema.js')).businessMembers)
    .where(
      and(
        eq((await import('../schema.js')).businessMembers.businessId, BIZ),
        eq((await import('../schema.js')).businessMembers.userId, userId),
      ),
    );
  return rows[0] ?? null;
}

beforeAll(async () => {
  await startPg();
});

afterAll(async () => {
  await stopPg();
});

beforeEach(async () => {
  await resetDatabase();
  await getDb().insert(businesses).values({ id: BIZ, name: 'Maya Threads' });
  await getDb().insert(businesses).values({ id: OTHER_BIZ, name: 'Other Shop' });
  await seedMembership(BIZ, OWNER, 'OWNER');
  await seedMembership(BIZ, STAFF, 'STAFF');
  await getDb().insert(users).values({
    id: NEWCOMER,
    email: 'newcomer@example.com',
    name: 'New Comer',
  });
});

describe('DrizzleTeamRepository membership reads', () => {
  it('lists only active members, owners first', async () => {
    await seedMembership(BIZ, '00000000-0000-0000-0000-0000000000b9', 'STAFF', {
      status: 'REMOVED',
    });

    const members = await repo.listMembers(BIZ);

    expect(members.map((member) => member.userId)).toEqual([OWNER, STAFF]);
    expect(members[0].role).toBe('OWNER');
    expect(members[0].joinedAt).toBeInstanceOf(Date);
  });

  it('finds a member by email regardless of case and trims whitespace', async () => {
    const stored = await getDb()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, STAFF));
    const member = await repo.findMemberByEmail(BIZ, `  ${stored[0].email.toUpperCase()} `);

    expect(member?.userId).toBe(STAFF);
    expect(await repo.findMemberByEmail(BIZ, 'nobody@example.com')).toBeNull();
  });

  it('never returns another business members', async () => {
    expect(await repo.findMemberById(OTHER_BIZ, 'anything')).toBeNull();
    expect(await repo.listMembers('not-a-uuid')).toEqual([]);
  });

  it('counts owners only among active memberships', async () => {
    await getDb()
      .update((await import('../schema.js')).businessMembers)
      .set({ status: 'REMOVED' })
      .where(
        and(
          eq((await import('../schema.js')).businessMembers.businessId, OTHER_BIZ),
          eq((await import('../schema.js')).businessMembers.userId, OWNER),
        ),
      );

    expect(await repo.countOwners(BIZ)).toBe(1);
  });
});

describe('DrizzleTeamRepository invitations', () => {
  it('lists live invitations newest first and hides accepted or revoked ones', async () => {
    const old = await seedInvitation('old@example.com');
    const fresh = await seedInvitation('fresh@example.com');
    await seedInvitation('accepted@example.com', { status: 'accepted' });
    await seedInvitation('revoked@example.com', { status: 'revoked' });
    await getDb()
      .update(invitations)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(invitations.id, old));

    const rows = await repo.listInvitations(BIZ);

    expect(rows.map((row) => row.id)).toEqual([fresh, old]);
    expect(rows[0].invitedByName).toBe('User 00000000');
  });

  it('rejects a second live invitation for the same email, in any letter case', async () => {
    await seedInvitation('dup@example.com');

    await expect(
      getDb()
        .insert(invitations)
        .values({
          businessId: BIZ,
          email: 'DUP@example.com',
          role: 'STAFF',
          tokenHash: hashInviteToken('another-token'),
          invitedByUserId: OWNER,
          expiresAt: later(7),
        }),
    ).rejects.toThrow();
  });

  it('allows a new invitation once the old one is revoked', async () => {
    const first = await seedInvitation('again@example.com');
    await repo.revokeInvitation(BIZ, first, { userId: OWNER });

    await expect(seedInvitation('again@example.com')).resolves.toBeTypeOf('string');
  });

  it('finds an invitation by token hash together with the business and inviter names', async () => {
    const token = 'preview-token';
    await seedInvitation('preview@example.com', { token });

    const context = await repo.findInvitationByTokenHash(hashInviteToken(token));

    expect(context?.businessName).toBe('Maya Threads');
    expect(context?.inviterName).toBe('User 00000000');
    expect(context?.invitation.email).toBe('preview@example.com');
    expect(await repo.findInvitationByTokenHash(hashInviteToken('missing'))).toBeNull();
  });

  it('rotates the token and audits the resend without storing the raw token', async () => {
    const id = await seedInvitation('rotate@example.com', { token: 'old-token' });
    const newHash = hashInviteToken('new-token');

    const rotated = await repo.rotateInvitation(BIZ, id, newHash, later(7), { userId: OWNER });

    expect(rotated?.tokenHash).toBe(newHash);
    expect(rotated?.emailStatus).toBe('QUEUED');
    expect(await repo.findInvitationByTokenHash(hashInviteToken('old-token'))).toBeNull();
    expect(await auditRows(id)).toEqual([
      { action: 'TEAM_INVITE_RESENT', entityType: 'Invitation' },
    ]);
    const raw = await getDb().select({ previousValue: auditLogs.previousValue }).from(auditLogs);
    expect(JSON.stringify(raw)).not.toContain('new-token');
    expect(JSON.stringify(raw)).not.toContain('old-token');
  });

  it('revokes an invitation and records the audit row', async () => {
    const id = await seedInvitation('cancel@example.com');

    expect(await repo.revokeInvitation(BIZ, id, { userId: OWNER })).toBe(true);

    const stored = await getDb().select().from(invitations).where(eq(invitations.id, id));
    expect(stored[0].revokedAt).toBeInstanceOf(Date);
    expect(await repo.revokeInvitation(BIZ, id, { userId: OWNER })).toBe(false);
    expect(await auditRows(id)).toEqual([
      { action: 'TEAM_INVITE_REVOKED', entityType: 'Invitation' },
    ]);
  });

  it('marks the email outcome only for the current token hash', async () => {
    const id = await seedInvitation('send@example.com', { token: 'live-token' });
    const liveHash = hashInviteToken('live-token');

    expect(await repo.markEmailSent(id, hashInviteToken('stale'))).toBe(false);
    await repo.setEmailAttempts(id, 2);
    expect(await repo.markEmailFailed(id, liveHash, 'PROVIDER_REJECTED')).toBe(true);

    let stored = await getDb().select().from(invitations).where(eq(invitations.id, id));
    expect(stored[0].emailStatus).toBe('FAILED');
    expect(stored[0].emailAttempts).toBe(2);
    expect(stored[0].lastEmailError).toBe('PROVIDER_REJECTED');
    expect(stored[0].sentAt).toBeNull();

    expect(await repo.markEmailSent(id, liveHash)).toBe(true);
    stored = await getDb().select().from(invitations).where(eq(invitations.id, id));
    expect(stored[0].emailStatus).toBe('SENT');
    expect(stored[0].sentAt).toBeInstanceOf(Date);
    expect(stored[0].lastEmailError).toBeNull();
  });

  it('marks a skipped send without clearing the queue state', async () => {
    const id = await seedInvitation('skip@example.com', { token: 'skip-token' });

    expect(await repo.markEmailSkipped(id, hashInviteToken('skip-token'))).toBe(true);

    const stored = await getDb().select().from(invitations).where(eq(invitations.id, id));
    expect(stored[0].emailStatus).toBe('SKIPPED');
    expect(stored[0].sentAt).toBeNull();
  });
});

describe('DrizzleTeamRepository member management', () => {
  it('changes a role and records the before and after values', async () => {
    const member = await repo.findMemberById(
      BIZ,
      (
        await getDb()
          .select({ id: (await import('../schema.js')).businessMembers.id })
          .from((await import('../schema.js')).businessMembers)
          .where(eq((await import('../schema.js')).businessMembers.userId, STAFF))
      )[0].id,
    );

    const updated = await repo.updateMemberRole(BIZ, member!.membershipId, 'OWNER', {
      userId: OWNER,
    });

    expect(updated?.role).toBe('OWNER');
    const audit = await getDb()
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, member!.membershipId),
          eq(auditLogs.action, 'TEAM_ROLE_CHANGED'),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0].entityType).toBe('BusinessMember');
    expect(audit[0].previousValue).toContain('STAFF');
    expect(audit[0].newValue).toContain('OWNER');
  });

  it('removes a member by marking the row and stamping removed_at', async () => {
    const row = (
      await getDb()
        .select({ id: (await import('../schema.js')).businessMembers.id })
        .from((await import('../schema.js')).businessMembers)
        .where(eq((await import('../schema.js')).businessMembers.userId, STAFF))
    )[0];

    expect(await repo.removeMember(BIZ, row.id, { userId: OWNER })).toBe(true);

    const stored = await membership(STAFF);
    expect(stored?.status).toBe('REMOVED');
    expect(stored?.removedAt).toBeInstanceOf(Date);
    expect(await repo.listMembers(BIZ)).toHaveLength(1);
    expect(await auditRows(row.id)).toEqual([
      { action: 'TEAM_MEMBER_REMOVED', entityType: 'BusinessMember' },
    ]);
  });
});

describe('DrizzleTeamRepository accept', () => {
  it('creates an account, activates the membership, and audits in one step', async () => {
    const token = 'accept-token';
    const id = await seedInvitation('hire@example.com', { token });

    const result = await repo.acceptInvitation({
      invitationId: id,
      email: 'hire@example.com',
      role: 'STAFF',
      name: 'Hire Me',
      passwordHash: 'hashed',
      accountExists: false,
    });

    const account = await getDb().select().from(users).where(eq(users.id, result.userId));
    expect(account[0].passwordHash).toBe('hashed');
    expect(account[0].name).toBe('Hire Me');
    expect(await membership(result.userId)).toMatchObject({ status: 'ACTIVE', role: 'STAFF' });

    const stored = await getDb().select().from(invitations).where(eq(invitations.id, id));
    expect(stored[0].acceptedAt).toBeInstanceOf(Date);
    expect(stored[0].acceptedByUserId).toBe(result.userId);
    expect(await auditRows(id)).toEqual([
      { action: 'TEAM_INVITE_ACCEPTED', entityType: 'Invitation' },
    ]);
  });

  it('reactivates a removed membership instead of inserting a second row', async () => {
    // A member who left earlier keeps their account and a removed row.
    await seedMembership(BIZ, NEWCOMER, 'STAFF', { status: 'REMOVED' });
    const fresh = await seedInvitation('newcomer@example.com');

    const result = await repo.acceptInvitation({
      invitationId: fresh,
      email: 'newcomer@example.com',
      role: 'STAFF',
      name: 'New Comer',
      existingUserId: NEWCOMER,
      accountExists: true,
    });

    expect(result.userId).toBe(NEWCOMER);
    const rows = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from((await import('../schema.js')).businessMembers)
      .where(
        and(
          eq((await import('../schema.js')).businessMembers.businessId, BIZ),
          eq((await import('../schema.js')).businessMembers.userId, NEWCOMER),
        ),
      );
    expect(rows[0].count).toBe(1);
    expect(await membership(NEWCOMER)).toMatchObject({
      status: 'ACTIVE',
      role: 'STAFF',
      removedAt: null,
    });
  });

  it('refuses a second accept on the same invitation', async () => {
    const id = await seedInvitation('twice@example.com');
    await repo.acceptInvitation({
      invitationId: id,
      email: 'twice@example.com',
      role: 'STAFF',
      name: 'Twice Once',
      passwordHash: 'hashed',
      accountExists: false,
    });

    await expect(
      repo.acceptInvitation({
        invitationId: id,
        email: 'twice@example.com',
        role: 'STAFF',
        name: 'Twice Again',
        passwordHash: 'hashed',
        accountExists: false,
      }),
    ).rejects.toThrow();
  });
});
