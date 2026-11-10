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
import { auditLogs, businessMembers, businesses, invitations, users } from '../schema.js';
import { hashInviteToken } from '../../../../domain/invitation-token.js';
import {
  InviteAlreadyAcceptedError,
  InviteAlreadyMemberError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  LastOwnerError,
} from '../../../../domain/errors.js';
import type { InvitationRole } from '../../../../domain/entities/invitation.entity.js';

// Covers AC-1, AC-9, AC-11, AC-12, AC-13, AC-14, AC-15, AC-16, AC-18, AC-19,
// and AC-20 against the real PostgreSQL schema.

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
  extra: {
    role?: InvitationRole;
    token?: string;
    status?: 'live' | 'accepted' | 'revoked';
    expiresAt?: Date;
  } = {},
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
      expiresAt: extra.expiresAt ?? later(7),
      acceptedAt: status === 'accepted' ? new Date() : null,
      revokedAt: status === 'revoked' ? new Date() : null,
    })
    .returning({ id: invitations.id });
  return rows[0].id;
}

async function membership(userId: string) {
  const rows = await getDb()
    .select()
    .from(businessMembers)
    .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, userId)));
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
    // A second owner in the same business, already removed. If countOwners
    // stops filtering on ACTIVE this assertion becomes 2.
    await seedMembership(BIZ, NEWCOMER, 'OWNER', { status: 'REMOVED' });

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

  it('creates an invitation and audits it in the same step', async () => {
    const created = await repo.createInvitation({
      businessId: BIZ,
      email: 'created@example.com',
      role: 'STAFF',
      tokenHash: hashInviteToken('created-token'),
      invitedByUserId: OWNER,
      expiresAt: later(7),
    });

    expect(created.email).toBe('created@example.com');
    expect(await auditRows(created.id)).toEqual([
      { action: 'TEAM_INVITE_CREATED', entityType: 'Invitation' },
    ]);
    const audit = await getDb().select().from(auditLogs).where(eq(auditLogs.entityId, created.id));
    expect(audit[0].userId).toBe(OWNER);
    expect(audit[0].newValue).toContain('created@example.com');
  });

  it('finds an invitation by token hash together with the business and inviter names', async () => {
    const token = 'preview-token';
    await seedInvitation('preview@example.com', { token });

    const context = await repo.findInvitationByTokenHash(hashInviteToken(token));

    expect(context?.businessName).toBe('Maya Threads');
    expect(context?.businessTimezone).toBe('Asia/Dhaka');
    expect(context?.inviterName).toBe('User 00000000');
    expect(context?.invitation.email).toBe('preview@example.com');
    expect(await repo.findInvitationByTokenHash(hashInviteToken('missing'))).toBeNull();
  });

  it('rotates the token and audits the resend without storing the raw token', async () => {
    const id = await seedInvitation('rotate@example.com', { token: 'old-token' });
    const newHash = hashInviteToken('new-token');

    const rotated = await repo.rotateInvitation(
      BIZ,
      id,
      newHash,
      later(7),
      { userId: OWNER },
      hashInviteToken('old-token'),
    );

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

  it('refuses to rotate on a token hash the caller never read', async () => {
    // A resend whose read is stale (another resend stored its hash first) must
    // fail at the database level, so no owner is handed a link that was already
    // replaced. A concurrent attempt races, so the guard is asserted directly:
    // a stale expected hash is refused, the current one still rotates.
    const id = await seedInvitation('stale-rotate@example.com', { token: 'live-token' });
    const idSecond = await seedInvitation('current-rotate@example.com', { token: 'second-token' });

    expect(
      await repo.rotateInvitation(
        BIZ,
        id,
        hashInviteToken('stale-new-token'),
        later(7),
        { userId: OWNER },
        hashInviteToken('a-stale-value'),
      ),
    ).toBeNull();
    expect(
      await repo.rotateInvitation(
        BIZ,
        idSecond,
        hashInviteToken('second-new-token'),
        later(7),
        { userId: OWNER },
        hashInviteToken('second-token'),
      ),
    ).not.toBeNull();
    expect(await repo.findInvitationByTokenHash(hashInviteToken('live-token'))).not.toBeNull();
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
    await repo.setEmailAttempts(id, liveHash, 2);
    expect(await repo.markEmailSent(id, liveHash)).toBe(true);

    const stored = await getDb().select().from(invitations).where(eq(invitations.id, id));
    expect(stored[0].emailStatus).toBe('SENT');
    expect(stored[0].sentAt).toBeInstanceOf(Date);
    expect(stored[0].emailAttempts).toBe(2);
    expect(stored[0].lastEmailError).toBeNull();
  });

  it('keeps a failed outcome when a late send finishes', async () => {
    // The create request can time out and mark the row FAILED while the job is
    // still in flight. When that job finally reports success it must not flip
    // the terminal row back to SENT.
    const id = await seedInvitation('late@example.com', { token: 'late-token' });
    const liveHash = hashInviteToken('late-token');

    expect(await repo.markEmailFailed(id, liveHash, 'PROVIDER_REJECTED')).toBe(true);
    expect(await repo.markEmailSent(id, liveHash)).toBe(false);

    const stored = await getDb().select().from(invitations).where(eq(invitations.id, id));
    expect(stored[0].emailStatus).toBe('FAILED');
    expect(stored[0].sentAt).toBeNull();
    expect(stored[0].lastEmailError).toBe('PROVIDER_REJECTED');
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
          .select({ id: businessMembers.id })
          .from(businessMembers)
          .where(eq(businessMembers.userId, STAFF))
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
        .select({ id: businessMembers.id })
        .from(businessMembers)
        .where(eq(businessMembers.userId, STAFF))
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

  it('refuses to remove the last owner', async () => {
    const ownerRow = (
      await getDb()
        .select({ id: businessMembers.id })
        .from(businessMembers)
        .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, OWNER)))
    )[0];

    await expect(repo.removeMember(BIZ, ownerRow.id, { userId: OWNER })).rejects.toBeInstanceOf(
      LastOwnerError,
    );

    expect(await membership(OWNER)).toMatchObject({ status: 'ACTIVE', removedAt: null });
    expect(await auditRows(ownerRow.id)).toEqual([]);
  });

  it('refuses to demote the last active owner', async () => {
    const ownerRow = (
      await getDb()
        .select({ id: businessMembers.id })
        .from(businessMembers)
        .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, OWNER)))
    )[0];

    await expect(
      repo.updateMemberRole(BIZ, ownerRow.id, 'STAFF', { userId: OWNER }),
    ).rejects.toBeInstanceOf(LastOwnerError);

    expect(await membership(OWNER)).toMatchObject({ status: 'ACTIVE', role: 'OWNER' });
    expect(await auditRows(ownerRow.id)).toEqual([]);
  });

  it('keeps one owner when two owners demote each other at the same moment', async () => {
    const secondOwner = '00000000-0000-0000-0000-0000000000b4';
    await seedMembership(BIZ, secondOwner, 'OWNER');

    const memberships = await getDb()
      .select({ id: businessMembers.id, userId: businessMembers.userId })
      .from(businessMembers)
      .where(eq(businessMembers.businessId, BIZ));
    const first = memberships.find((member) => member.userId === OWNER)!;
    const second = memberships.find((member) => member.userId === secondOwner)!;

    const results = await Promise.allSettled([
      repo.updateMemberRole(BIZ, first.id, 'STAFF', { userId: OWNER }),
      repo.updateMemberRole(BIZ, second.id, 'STAFF', { userId: secondOwner }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(LastOwnerError);
    expect(await repo.countOwners(BIZ)).toBe(1);
  });

  it('keeps one owner when a removal and a demotion race each other', async () => {
    const secondOwner = '00000000-0000-0000-0000-0000000000b5';
    await seedMembership(BIZ, secondOwner, 'OWNER');

    const memberships = await getDb()
      .select({ id: businessMembers.id, userId: businessMembers.userId })
      .from(businessMembers)
      .where(eq(businessMembers.businessId, BIZ));
    const first = memberships.find((member) => member.userId === OWNER)!;
    const second = memberships.find((member) => member.userId === secondOwner)!;

    const results = await Promise.allSettled([
      repo.updateMemberRole(BIZ, first.id, 'STAFF', { userId: secondOwner }),
      repo.removeMember(BIZ, second.id, { userId: OWNER }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(LastOwnerError);
    expect(await repo.countOwners(BIZ)).toBe(1);
  });
});

describe('DrizzleTeamRepository accept', () => {
  it('creates an account, activates the membership, and audits in one step', async () => {
    const token = 'accept-token';
    const id = await seedInvitation('hire@example.com', { token });

    const result = await repo.acceptInvitation({
      invitationId: id,
      tokenHash: hashInviteToken(token),
      name: 'Hire Me',
      passwordHash: 'hashed',
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
    const reactivateToken = 'reactivate-token';
    const fresh = await seedInvitation('newcomer@example.com', { token: reactivateToken });

    const result = await repo.acceptInvitation({
      invitationId: fresh,
      tokenHash: hashInviteToken(reactivateToken),
      name: 'New Comer',
      existingUserId: NEWCOMER,
    });

    expect(result.userId).toBe(NEWCOMER);
    const rows = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(businessMembers)
      .where(and(eq(businessMembers.businessId, BIZ), eq(businessMembers.userId, NEWCOMER)));
    expect(rows[0].count).toBe(1);
    expect(await membership(NEWCOMER)).toMatchObject({
      status: 'ACTIVE',
      role: 'STAFF',
      removedAt: null,
    });
  });

  it('refuses an accept that would rewrite an already active membership', async () => {
    // An active member with a live invitation is the interleaving the service
    // cannot see from its pre-transaction read. The transaction must refuse it
    // and leave the row untouched.
    const token = 'active-member-token';
    const email = `${STAFF}@example.com`;
    const id = await seedInvitation(email, { token });

    await expect(
      repo.acceptInvitation({
        invitationId: id,
        tokenHash: hashInviteToken(token),
        name: 'Staff Member',
        existingUserId: STAFF,
      }),
    ).rejects.toBeInstanceOf(InviteAlreadyMemberError);

    expect(await membership(STAFF)).toMatchObject({ status: 'ACTIVE', role: 'STAFF' });
    const stored = await getDb().select().from(invitations).where(eq(invitations.id, id));
    expect(stored[0].acceptedAt).toBeNull();
  });

  it('falls back to the supplied name when an existing account has a blank name', async () => {
    await getDb().update(users).set({ name: '' }).where(eq(users.id, NEWCOMER));
    const token = 'blank-name-token';
    const id = await seedInvitation('newcomer@example.com', { token });

    await repo.acceptInvitation({
      invitationId: id,
      tokenHash: hashInviteToken(token),
      name: 'newcomer',
      existingUserId: NEWCOMER,
    });

    const account = await getDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, NEWCOMER));
    expect(account[0].name).toBe('newcomer');
  });

  it('keeps a non blank stored name when the accept body sends none', async () => {
    const token = 'stored-name-token';
    const id = await seedInvitation('newcomer@example.com', { token });

    await repo.acceptInvitation({
      invitationId: id,
      tokenHash: hashInviteToken(token),
      name: 'newcomer',
      existingUserId: NEWCOMER,
    });

    const account = await getDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, NEWCOMER));
    expect(account[0].name).toBe('New Comer');
  });

  it('lets a name in the accept body win and updates the stored account', async () => {
    const token = 'requested-name-token';
    const id = await seedInvitation('newcomer@example.com', { token });

    await repo.acceptInvitation({
      invitationId: id,
      tokenHash: hashInviteToken(token),
      name: 'newcomer',
      requestedName: 'Requested Name',
      existingUserId: NEWCOMER,
    });

    const account = await getDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, NEWCOMER));
    expect(account[0].name).toBe('Requested Name');
  });

  it('creates an account with the requested name when one is supplied', async () => {
    const token = 'new-hire-name-token';
    const id = await seedInvitation('hire@example.com', { token });

    const result = await repo.acceptInvitation({
      invitationId: id,
      tokenHash: hashInviteToken(token),
      name: 'hire',
      requestedName: 'Hire Me',
      passwordHash: 'hashed',
    });

    const account = await getDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, result.userId));
    expect(account[0].name).toBe('Hire Me');
  });

  it('refuses a second accept on the same invitation', async () => {
    const token = 'twice-token';
    const id = await seedInvitation('twice@example.com', { token });
    await repo.acceptInvitation({
      invitationId: id,
      tokenHash: hashInviteToken(token),
      name: 'Twice Once',
      passwordHash: 'hashed',
    });

    await expect(
      repo.acceptInvitation({
        invitationId: id,
        tokenHash: hashInviteToken(token),
        name: 'Twice Again',
        passwordHash: 'hashed',
      }),
    ).rejects.toBeInstanceOf(InviteAlreadyAcceptedError);
  });

  it('refuses a signed in second accept after the first one succeeded', async () => {
    const token = 'signed-in-twice-token';
    const id = await seedInvitation('newcomer@example.com', { token });
    await repo.acceptInvitation({
      invitationId: id,
      tokenHash: hashInviteToken(token),
      name: 'New Comer',
      existingUserId: NEWCOMER,
    });

    await expect(
      repo.acceptInvitation({
        invitationId: id,
        tokenHash: hashInviteToken(token),
        name: 'New Comer',
        existingUserId: NEWCOMER,
      }),
    ).rejects.toBeInstanceOf(InviteAlreadyAcceptedError);
  });

  it('refuses a revoked invitation', async () => {
    const token = 'revoked-token';
    const id = await seedInvitation('gone@example.com', { token });
    await repo.revokeInvitation(BIZ, id, { userId: OWNER });

    await expect(
      repo.acceptInvitation({
        invitationId: id,
        tokenHash: hashInviteToken(token),
        name: 'Gone',
        passwordHash: 'hashed',
      }),
    ).rejects.toBeInstanceOf(InviteRevokedError);
  });

  it('refuses an expired invitation', async () => {
    const token = 'expired-token';
    const id = await seedInvitation('late@example.com', {
      token,
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(
      repo.acceptInvitation({
        invitationId: id,
        tokenHash: hashInviteToken(token),
        name: 'Late',
        passwordHash: 'hashed',
      }),
    ).rejects.toBeInstanceOf(InviteExpiredError);
  });

  it('refuses the old token after a resend rotates it', async () => {
    const oldToken = 'rotated-away-token';
    const id = await seedInvitation('rotate-accept@example.com', { token: oldToken });
    await repo.rotateInvitation(
      BIZ,
      id,
      hashInviteToken('replacement-token'),
      later(7),
      { userId: OWNER },
      hashInviteToken(oldToken),
    );

    await expect(
      repo.acceptInvitation({
        invitationId: id,
        tokenHash: hashInviteToken(oldToken),
        name: 'Rotated',
        passwordHash: 'hashed',
      }),
    ).rejects.toBeInstanceOf(InviteNotFoundError);
  });

  it('settles an accept racing a cancel without both succeeding', async () => {
    const token = 'race-cancel-token';
    const id = await seedInvitation('race-cancel@example.com', { token });

    const [acceptResult, revokeResult] = await Promise.allSettled([
      repo.acceptInvitation({
        invitationId: id,
        tokenHash: hashInviteToken(token),
        name: 'Race Cancel',
        passwordHash: 'hashed',
      }),
      repo.revokeInvitation(BIZ, id, { userId: OWNER }),
    ]);

    const revoked = revokeResult.status === 'fulfilled' && revokeResult.value;
    if (revoked) {
      expect(acceptResult.status).toBe('rejected');
      if (acceptResult.status === 'rejected') {
        expect(acceptResult.reason).toBeInstanceOf(InviteRevokedError);
      }
    } else {
      expect(acceptResult.status).toBe('fulfilled');
      expect(revokeResult).toEqual({ status: 'fulfilled', value: false });
    }
  });

  it('settles an accept racing a resend without both succeeding', async () => {
    const token = 'race-resend-token';
    const id = await seedInvitation('race-resend@example.com', { token });

    const [acceptResult, rotateResult] = await Promise.allSettled([
      repo.acceptInvitation({
        invitationId: id,
        tokenHash: hashInviteToken(token),
        name: 'Race Resend',
        passwordHash: 'hashed',
      }),
      repo.rotateInvitation(
        BIZ,
        id,
        hashInviteToken('race-new-token'),
        later(7),
        { userId: OWNER },
        hashInviteToken(token),
      ),
    ]);

    const rotated = rotateResult.status === 'fulfilled' && rotateResult.value !== null;
    if (rotated) {
      expect(acceptResult.status).toBe('rejected');
      if (acceptResult.status === 'rejected') {
        expect(acceptResult.reason).toBeInstanceOf(InviteNotFoundError);
      }
    } else {
      expect(acceptResult.status).toBe('fulfilled');
      expect(rotateResult).toEqual({ status: 'fulfilled', value: null });
    }
  });
});
