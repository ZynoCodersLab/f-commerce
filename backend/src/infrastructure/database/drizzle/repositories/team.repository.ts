import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../client.js';
import { auditLogs, businessMembers, businesses, invitations, users } from '../schema.js';
import { isUuid } from '../../../../domain/uuid.js';
import {
  AcceptResult,
  ITeamRepository,
  InvitationContext,
  NewInvitationData,
  TeamInvitationRecord,
  TeamMemberRecord,
} from '../../../../domain/repositories/team.repository.js';
import {
  Invitation,
  InvitationEmailStatus,
  InvitationRole,
} from '../../../../domain/entities/invitation.entity.js';
import {
  InviteAlreadyAcceptedError,
  InviteAlreadyMemberError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  LastOwnerError,
} from '../../../../domain/errors.js';
import { TeamAuditAction, TeamAuditEntity } from '@f-commerce/contracts';

type InvitationRow = typeof invitations.$inferSelect;

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    businessId: row.businessId,
    email: row.email,
    role: row.role === 'OWNER' ? 'OWNER' : 'STAFF',
    tokenHash: row.tokenHash,
    invitedByUserId: row.invitedByUserId,
    acceptedByUserId: row.acceptedByUserId ?? undefined,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt ?? undefined,
    revokedAt: row.revokedAt ?? undefined,
    lastSentAt: row.lastSentAt,
    emailStatus: row.emailStatus as InvitationEmailStatus,
    emailAttempts: row.emailAttempts,
    lastEmailError: row.lastEmailError ?? undefined,
    sentAt: row.sentAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Windows and Postgres timestamp columns come back as Date through the driver,
 * but a raw SQL result can hand back a string. Accept both.
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export class DrizzleTeamRepository implements ITeamRepository {
  async listMembers(businessId: string): Promise<TeamMemberRecord[]> {
    if (!isUuid(businessId)) return [];

    const rows = await getDb()
      .select({
        membershipId: businessMembers.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        role: businessMembers.role,
        joinedAt: businessMembers.createdAt,
      })
      .from(businessMembers)
      .innerJoin(users, eq(businessMembers.userId, users.id))
      .where(and(eq(businessMembers.businessId, businessId), eq(businessMembers.status, 'ACTIVE')))
      .orderBy(
        sql`case when ${businessMembers.role} = 'OWNER' then 0 else 1 end`,
        asc(users.name),
        asc(users.email),
      );

    return rows.map((row) => ({
      membershipId: row.membershipId,
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: row.role === 'OWNER' ? 'OWNER' : 'STAFF',
      joinedAt: toDate(row.joinedAt),
    }));
  }

  async listInvitations(businessId: string): Promise<TeamInvitationRecord[]> {
    if (!isUuid(businessId)) return [];

    const rows = await getDb()
      .select({
        invitation: invitations,
        inviterName: users.name,
      })
      .from(invitations)
      .innerJoin(users, eq(invitations.invitedByUserId, users.id))
      .where(
        and(
          eq(invitations.businessId, businessId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .orderBy(sql`${invitations.createdAt} desc`);

    return rows.map((row) => ({ ...toInvitation(row.invitation), invitedByName: row.inviterName }));
  }

  async countOwners(businessId: string): Promise<number> {
    const rows = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(businessMembers)
      .where(
        and(
          eq(businessMembers.businessId, businessId),
          eq(businessMembers.status, 'ACTIVE'),
          eq(businessMembers.role, 'OWNER'),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async findMemberById(businessId: string, membershipId: string): Promise<TeamMemberRecord | null> {
    if (!isUuid(businessId) || !isUuid(membershipId)) return null;

    const rows = await getDb()
      .select({
        membershipId: businessMembers.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        role: businessMembers.role,
        joinedAt: businessMembers.createdAt,
      })
      .from(businessMembers)
      .innerJoin(users, eq(businessMembers.userId, users.id))
      .where(
        and(
          eq(businessMembers.id, membershipId),
          eq(businessMembers.businessId, businessId),
          eq(businessMembers.status, 'ACTIVE'),
        ),
      );

    const row = rows[0];
    if (!row) return null;
    return {
      membershipId: row.membershipId,
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: row.role === 'OWNER' ? 'OWNER' : 'STAFF',
      joinedAt: toDate(row.joinedAt),
    };
  }

  async findMemberByEmail(businessId: string, email: string): Promise<TeamMemberRecord | null> {
    if (!isUuid(businessId)) return null;

    // Bring the caller's text to one letter case before comparing against the
    // stored lowercase form, so trimming and case never decide access.
    const candidate = normaliseEmail(email);
    if (candidate === '') return null;

    const rows = await getDb()
      .select({
        membershipId: businessMembers.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        role: businessMembers.role,
        joinedAt: businessMembers.createdAt,
      })
      .from(businessMembers)
      .innerJoin(users, eq(businessMembers.userId, users.id))
      .where(
        and(
          eq(businessMembers.businessId, businessId),
          eq(businessMembers.status, 'ACTIVE'),
          sql`lower(${users.email}) = ${candidate}`,
        ),
      );

    const row = rows[0];
    if (!row) return null;
    return {
      membershipId: row.membershipId,
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: row.role === 'OWNER' ? 'OWNER' : 'STAFF',
      joinedAt: toDate(row.joinedAt),
    };
  }

  async findInvitationById(
    businessId: string,
    invitationId: string,
  ): Promise<TeamInvitationRecord | null> {
    if (!isUuid(businessId) || !isUuid(invitationId)) return null;

    const rows = await getDb()
      .select({ invitation: invitations, inviterName: users.name })
      .from(invitations)
      .innerJoin(users, eq(invitations.invitedByUserId, users.id))
      .where(and(eq(invitations.id, invitationId), eq(invitations.businessId, businessId)));

    const row = rows[0];
    if (!row) return null;
    return { ...toInvitation(row.invitation), invitedByName: row.inviterName };
  }

  async findLiveInvitationByEmail(businessId: string, email: string): Promise<Invitation | null> {
    if (!isUuid(businessId)) return null;

    const rows = await getDb()
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.businessId, businessId),
          sql`lower(${invitations.email}) = ${normaliseEmail(email)}`,
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .limit(1);

    return rows[0] ? toInvitation(rows[0]) : null;
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<InvitationContext | null> {
    const rows = await getDb()
      .select({
        invitation: invitations,
        businessName: businesses.name,
        businessTimezone: businesses.timezone,
        inviterName: users.name,
      })
      .from(invitations)
      .innerJoin(businesses, eq(invitations.businessId, businesses.id))
      .innerJoin(users, eq(invitations.invitedByUserId, users.id))
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      invitation: toInvitation(row.invitation),
      businessName: row.businessName,
      businessTimezone: row.businessTimezone,
      inviterName: row.inviterName,
    };
  }

  async createInvitation(data: NewInvitationData): Promise<Invitation> {
    return getDb().transaction(async (tx) => {
      const now = new Date();
      const rows = await tx
        .insert(invitations)
        .values({
          businessId: data.businessId,
          email: normaliseEmail(data.email),
          role: data.role,
          tokenHash: data.tokenHash,
          invitedByUserId: data.invitedByUserId,
          expiresAt: data.expiresAt,
          lastSentAt: now,
          emailStatus: 'QUEUED',
          emailAttempts: 0,
        })
        .returning();

      const row = rows[0];
      if (!row) throw new Error('Failed to create invitation');

      await tx.insert(auditLogs).values({
        businessId: data.businessId,
        userId: data.invitedByUserId,
        action: TeamAuditAction.INVITE_CREATED,
        entityType: TeamAuditEntity.INVITATION,
        entityId: row.id,
        previousValue: JSON.stringify({ email: null }),
        newValue: JSON.stringify({
          email: row.email,
          role: row.role,
          expiresAt: data.expiresAt.toISOString(),
        }),
      });

      return toInvitation(row);
    });
  }

  async rotateInvitation(
    businessId: string,
    invitationId: string,
    tokenHash: string,
    expiresAt: Date,
    audit: { userId: string },
    expectedTokenHash: string,
  ): Promise<Invitation | null> {
    if (!isUuid(businessId) || !isUuid(invitationId)) return null;

    return getDb().transaction(async (tx) => {
      const now = new Date();
      // Read before updating: RETURNING reports the row after the change, so
      // the previous hash and expiry would otherwise be lost.
      const previous = await tx
        .select({ tokenHash: invitations.tokenHash, expiresAt: invitations.expiresAt })
        .from(invitations)
        .where(and(eq(invitations.id, invitationId), eq(invitations.businessId, businessId)))
        .limit(1);

      // The update also requires the stored hash to equal the one the caller
      // read. Without that condition two resends racing one invitation both
      // succeed, and the first owner is left looking at a link whose token has
      // already been replaced by the second (and no longer matches).
      const rows = await tx
        .update(invitations)
        .set({
          tokenHash,
          expiresAt,
          lastSentAt: now,
          emailStatus: 'QUEUED',
          emailAttempts: 0,
          lastEmailError: null,
          sentAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(invitations.id, invitationId),
            eq(invitations.businessId, businessId),
            eq(invitations.tokenHash, expectedTokenHash),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning();

      const row = rows[0];
      if (!row) return null;

      await tx.insert(auditLogs).values({
        businessId,
        userId: audit.userId,
        action: TeamAuditAction.INVITE_RESENT,
        entityType: TeamAuditEntity.INVITATION,
        entityId: row.id,
        // When the guarded update matched, the hash the caller read is the one
        // just replaced, so it is the true previous value. The hash is stored as
        // a hash, never the raw token.
        previousValue: JSON.stringify({
          tokenHash: expectedTokenHash,
          expiresAt: previous[0]?.expiresAt ?? null,
        }),
        newValue: JSON.stringify({ email: row.email, role: row.role, expiresAt }),
      });

      return toInvitation(row);
    });
  }

  async revokeInvitation(
    businessId: string,
    invitationId: string,
    audit: { userId: string },
  ): Promise<boolean> {
    if (!isUuid(businessId) || !isUuid(invitationId)) return false;

    return getDb().transaction(async (tx) => {
      const now = new Date();
      const rows = await tx
        .update(invitations)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(invitations.id, invitationId),
            eq(invitations.businessId, businessId),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id, email: invitations.email });

      const row = rows[0];
      if (!row) return false;

      await tx.insert(auditLogs).values({
        businessId,
        userId: audit.userId,
        action: TeamAuditAction.INVITE_REVOKED,
        entityType: TeamAuditEntity.INVITATION,
        entityId: row.id,
        previousValue: JSON.stringify({ email: row.email, revokedAt: null }),
        newValue: JSON.stringify({ email: row.email, revokedAt: now.toISOString() }),
      });

      return true;
    });
  }

  private async settleEmail(
    invitationId: string,
    tokenHash: string,
    changes: Partial<typeof invitations.$inferInsert>,
  ): Promise<boolean> {
    const now = new Date();
    const rows = await getDb()
      .update(invitations)
      .set({ ...changes, updatedAt: now })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.tokenHash, tokenHash),
          // Only a row still waiting to send may change status. A late job that
          // finishes after a timeout marked the row FAILED must not flip it to
          // SENT, and a sent row must never be marked failed or skipped.
          eq(invitations.emailStatus, 'QUEUED'),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id });
    return rows.length > 0;
  }

  async markEmailSent(invitationId: string, tokenHash: string): Promise<boolean> {
    const now = new Date();
    return this.settleEmail(invitationId, tokenHash, {
      emailStatus: 'SENT',
      sentAt: now,
      lastEmailError: null,
    });
  }

  async markEmailFailed(invitationId: string, tokenHash: string, reason: string): Promise<boolean> {
    return this.settleEmail(invitationId, tokenHash, {
      emailStatus: 'FAILED',
      lastEmailError: reason,
    });
  }

  async markEmailSkipped(invitationId: string, tokenHash: string): Promise<boolean> {
    return this.settleEmail(invitationId, tokenHash, { emailStatus: 'SKIPPED' });
  }

  async setEmailAttempts(invitationId: string, tokenHash: string, attempts: number): Promise<void> {
    if (!isUuid(invitationId)) return;
    await getDb()
      .update(invitations)
      .set({ emailAttempts: attempts, updatedAt: new Date() })
      .where(and(eq(invitations.id, invitationId), eq(invitations.tokenHash, tokenHash)));
  }

  async updateMemberRole(
    businessId: string,
    membershipId: string,
    role: InvitationRole,
    audit: { userId: string },
  ): Promise<TeamMemberRecord | null> {
    if (!isUuid(businessId) || !isUuid(membershipId)) return null;

    return getDb().transaction(async (tx) => {
      const now = new Date();
      // One lock per business serializes every role change and removal, so two
      // owners demoted at the same moment cannot both pass the owner count.
      await tx.execute(sql`select id from ${businesses} where id = ${businessId} for update`);

      // Read the role first: RETURNING reports the row after the update, so
      // the old value would be lost.
      const existing = await tx
        .select({ role: businessMembers.role })
        .from(businessMembers)
        .where(
          and(
            eq(businessMembers.id, membershipId),
            eq(businessMembers.businessId, businessId),
            eq(businessMembers.status, 'ACTIVE'),
          ),
        )
        .limit(1);

      if (existing.length === 0) return null;
      const previousRole: InvitationRole = existing[0].role === 'OWNER' ? 'OWNER' : 'STAFF';

      if (previousRole === 'OWNER' && role === 'STAFF') {
        const owners = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(businessMembers)
          .where(
            and(
              eq(businessMembers.businessId, businessId),
              eq(businessMembers.status, 'ACTIVE'),
              eq(businessMembers.role, 'OWNER'),
            ),
          );
        if ((owners[0]?.count ?? 0) <= 1) throw new LastOwnerError();
      }

      const rows = await tx
        .update(businessMembers)
        .set({ role, updatedAt: now })
        .where(
          and(
            eq(businessMembers.id, membershipId),
            eq(businessMembers.businessId, businessId),
            eq(businessMembers.status, 'ACTIVE'),
          ),
        )
        .returning({
          membershipId: businessMembers.id,
          userId: businessMembers.userId,
        });

      const row = rows[0];
      if (!row) return null;

      await tx.insert(auditLogs).values({
        businessId,
        userId: audit.userId,
        action: TeamAuditAction.ROLE_CHANGED,
        entityType: TeamAuditEntity.BUSINESS_MEMBER,
        entityId: row.membershipId,
        previousValue: JSON.stringify({ role: previousRole }),
        newValue: JSON.stringify({ role }),
      });

      const member = await tx
        .select({
          membershipId: businessMembers.id,
          userId: users.id,
          name: users.name,
          email: users.email,
          role: businessMembers.role,
          joinedAt: businessMembers.createdAt,
        })
        .from(businessMembers)
        .innerJoin(users, eq(businessMembers.userId, users.id))
        .where(
          and(eq(businessMembers.id, membershipId), eq(businessMembers.businessId, businessId)),
        )
        .limit(1);

      const found = member[0];
      if (!found) return null;
      return {
        membershipId: found.membershipId,
        userId: found.userId,
        name: found.name,
        email: found.email,
        role: found.role === 'OWNER' ? 'OWNER' : 'STAFF',
        joinedAt: toDate(found.joinedAt),
      };
    });
  }

  async removeMember(
    businessId: string,
    membershipId: string,
    audit: { userId: string },
  ): Promise<boolean> {
    if (!isUuid(businessId) || !isUuid(membershipId)) return false;

    return getDb().transaction(async (tx) => {
      const now = new Date();
      // Same business lock as a role change: removal and demotion must not race
      // each other past the last owner check.
      await tx.execute(sql`select id from ${businesses} where id = ${businessId} for update`);

      const existing = await tx
        .select({ role: businessMembers.role })
        .from(businessMembers)
        .where(
          and(
            eq(businessMembers.id, membershipId),
            eq(businessMembers.businessId, businessId),
            eq(businessMembers.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (existing.length === 0) return false;

      if (existing[0].role === 'OWNER') {
        const owners = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(businessMembers)
          .where(
            and(
              eq(businessMembers.businessId, businessId),
              eq(businessMembers.status, 'ACTIVE'),
              eq(businessMembers.role, 'OWNER'),
            ),
          );
        if ((owners[0]?.count ?? 0) <= 1) throw new LastOwnerError();
      }

      const rows = await tx
        .update(businessMembers)
        .set({ status: 'REMOVED', removedAt: now, updatedAt: now })
        .where(
          and(
            eq(businessMembers.id, membershipId),
            eq(businessMembers.businessId, businessId),
            eq(businessMembers.status, 'ACTIVE'),
          ),
        )
        .returning({ id: businessMembers.id, role: businessMembers.role });

      const row = rows[0];
      if (!row) return false;

      await tx.insert(auditLogs).values({
        businessId,
        userId: audit.userId,
        action: TeamAuditAction.MEMBER_REMOVED,
        entityType: TeamAuditEntity.BUSINESS_MEMBER,
        entityId: row.id,
        previousValue: JSON.stringify({ status: 'ACTIVE', role: row.role }),
        newValue: JSON.stringify({ status: 'REMOVED', removedAt: now.toISOString() }),
      });

      return true;
    });
  }

  async acceptInvitation(input: {
    invitationId: string;
    tokenHash: string;
    name: string;
    requestedName?: string;
    passwordHash?: string;
    existingUserId?: string;
  }): Promise<AcceptResult> {
    return getDb().transaction(async (tx) => {
      // Lock the invitation so two accepts, or an accept racing a resend or a
      // cancel, can never both succeed. The row decides expiry, cancellation,
      // whether it was already used, and whether this link is still current.
      const locked = await tx.execute(
        sql`select id, business_id, role, email, token_hash, accepted_at, revoked_at, expires_at from ${invitations} where id = ${input.invitationId} for update`,
      );
      const lockedRow = (locked.rows ?? [])[0] as
        | {
            business_id: string;
            role: string;
            email: string;
            token_hash: string;
            accepted_at: string | null;
            revoked_at: string | null;
            expires_at: string;
          }
        | undefined;
      if (!lockedRow) throw new InviteNotFoundError();
      // A resend replaces the hash, so the old link is no longer an invitation.
      if (lockedRow.token_hash !== input.tokenHash) throw new InviteNotFoundError();
      if (lockedRow.revoked_at) throw new InviteRevokedError();
      if (lockedRow.accepted_at) throw new InviteAlreadyAcceptedError();

      const now = new Date();
      if (toDate(lockedRow.expires_at).getTime() <= now.getTime()) throw new InviteExpiredError();

      const email = normaliseEmail(lockedRow.email);
      const role: InvitationRole = lockedRow.role === 'OWNER' ? 'OWNER' : 'STAFF';
      let userId = input.existingUserId;
      const requestedName = input.requestedName?.trim();
      // The body name wins, then a non blank stored name, then the caller's
      // fallback (the invitation address local part).
      let name = requestedName || input.name;

      if (userId) {
        const row = (
          await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1)
        )[0];
        const storedName = row?.name.trim() ?? '';
        name = requestedName || storedName || input.name;

        if (name !== storedName) {
          await tx.update(users).set({ name, updatedAt: now }).where(eq(users.id, userId));
        }
        if (input.passwordHash) {
          await tx
            .update(users)
            .set({ passwordHash: input.passwordHash, updatedAt: now })
            .where(eq(users.id, userId));
        }
      } else {
        const created = await tx
          .insert(users)
          .values({
            email,
            name: requestedName || input.name,
            passwordHash: input.passwordHash ?? null,
            oauth: [],
            isActive: true,
          })
          .returning({ id: users.id, name: users.name });
        userId = created[0].id;
        name = created[0].name;
      }

      const businessId = lockedRow.business_id;

      // Re-read the membership inside the lock. The caller checks before this
      // transaction, so an active membership that appeared in between must not
      // be silently rewritten to the invited role, which could demote an owner.
      // A removed row is safe and is reactivated below.
      const currentMembership = (
        await tx
          .select({ status: businessMembers.status })
          .from(businessMembers)
          .where(
            and(eq(businessMembers.businessId, businessId), eq(businessMembers.userId, userId)),
          )
          .limit(1)
      )[0];
      if (currentMembership?.status === 'ACTIVE') throw new InviteAlreadyMemberError();

      // A previously removed member comes back with the invited role.
      const reactivated = await tx
        .update(businessMembers)
        .set({
          role,
          status: 'ACTIVE',
          removedAt: null,
          updatedAt: now,
        })
        .where(and(eq(businessMembers.businessId, businessId), eq(businessMembers.userId, userId)))
        .returning({ id: businessMembers.id });

      let membershipId = reactivated[0]?.id;
      if (!membershipId) {
        const inserted = await tx
          .insert(businessMembers)
          .values({
            businessId,
            userId,
            role,
            status: 'ACTIVE',
          })
          .returning({ id: businessMembers.id });
        membershipId = inserted[0].id;
      }

      const accepted = await tx
        .update(invitations)
        .set({ acceptedAt: now, acceptedByUserId: userId, updatedAt: now })
        .where(
          and(
            eq(invitations.id, input.invitationId),
            eq(invitations.tokenHash, input.tokenHash),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (accepted.length === 0) throw new InviteAlreadyAcceptedError();

      await tx.insert(auditLogs).values({
        businessId,
        userId,
        action: TeamAuditAction.INVITE_ACCEPTED,
        entityType: TeamAuditEntity.INVITATION,
        entityId: input.invitationId,
        previousValue: JSON.stringify({ acceptedAt: null }),
        newValue: JSON.stringify({
          acceptedAt: now.toISOString(),
          membershipId,
          role,
          email,
          name,
        }),
      });

      return { membershipId, userId, businessId, role };
    });
  }
}
