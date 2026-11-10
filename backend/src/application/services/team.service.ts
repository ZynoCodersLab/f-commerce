import bcrypt from 'bcrypt';
import {
  InviteAcceptRequest,
  InviteCreateRequest,
  TeamInvitation,
  TeamListResponse,
  TeamMember,
  TeamRole,
} from '@f-commerce/contracts';
import { IAuthRepository } from '../../domain/repositories/auth.repository.js';
import {
  AcceptResult,
  ITeamRepository,
  TeamInvitationRecord,
  TeamMemberRecord,
} from '../../domain/repositories/team.repository.js';
import { Invitation } from '../../domain/entities/invitation.entity.js';
import {
  EmailMismatchError,
  InviteAlreadyAcceptedError,
  InviteAlreadyMemberError,
  InviteAlreadyPendingError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteResendConflictError,
  InviteRevokedError,
  LastOwnerError,
  SelfChangeNotAllowedError,
  SignInRequiredError,
  TeamMemberNotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../domain/errors.js';
import {
  buildInviteUrl,
  expiryFromNow,
  generateInviteToken,
  hashInviteToken,
} from '../../domain/invitation-token.js';
import { isUniqueViolation, uniqueViolationConstraint } from './database-errors.js';

/** Where the worker gets its work, kept behind a tiny port so tests can stub it. */
export interface InviteEmailQueue {
  enqueue(data: { invitationId: string; tokenHash: string; token: string }): Promise<boolean>;
}

/**
 * Whether this deployment can send email. The interface layer answers, so the
 * application layer never imports a provider client.
 */
export interface EmailDeliveryPort {
  isConfigured(): boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  businessId: string;
}

/** The auth collaborator, limited to what the team feature needs. */
export interface InviteTokenIssuer {
  issueTokensForUser(
    userId: string,
    preferredBusinessId: string,
  ): Promise<{ accessToken: string; refreshToken: string }>;
}

export interface InvitePreview {
  businessName: string;
  inviterName: string;
  email: string;
  role: TeamRole;
  expiresAt: string;
  timezone: string;
  accountExists: boolean;
  hasPassword: boolean;
  alreadyMember: boolean;
}

function toMemberDto(member: TeamMemberRecord): TeamMember {
  return {
    id: member.membershipId,
    userId: member.userId,
    name: member.name,
    email: member.email,
    role: member.role,
    joinedAt: member.joinedAt.toISOString(),
  };
}

/** An invitation is expired once its expiry has passed, even before the worker says so. */
function invitationStatus(invitation: Invitation, now: Date): 'PENDING' | 'EXPIRED' {
  return invitation.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'PENDING';
}

function toInvitationDto(invitation: TeamInvitationRecord, now: Date): TeamInvitation {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    invitedByName: invitation.invitedByName,
    sentAt: invitation.sentAt ? invitation.sentAt.toISOString() : null,
    lastSentAt: invitation.lastSentAt.toISOString(),
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    status: invitationStatus(invitation, now),
    emailStatus: invitation.emailStatus,
    // Only a failed send carries a reason the screen may show.
    emailError: invitation.emailStatus === 'FAILED' ? (invitation.lastEmailError ?? null) : null,
  };
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The team screen and the invitation flow.
 *
 * Invitations are their own rows, so an invitation is never a half created
 * account: nothing it holds grants access until it is accepted, and then the
 * account and the membership are created in the same transaction that marks
 * the invitation used.
 */
export class TeamService {
  constructor(
    private readonly teamRepository: ITeamRepository,
    private readonly authRepository: IAuthRepository,
    private readonly emailQueue: InviteEmailQueue,
    private readonly emailDelivery: EmailDeliveryPort,
    private readonly tokenIssuer: InviteTokenIssuer,
    private readonly appOrigin: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(businessId: string): Promise<TeamListResponse['data']> {
    const now = this.now();
    const [members, invitations] = await Promise.all([
      this.teamRepository.listMembers(businessId),
      this.teamRepository.listInvitations(businessId),
    ]);

    return {
      members: members.map(toMemberDto),
      invitations: invitations.map((invitation) => toInvitationDto(invitation, now)),
    };
  }

  /**
   * Create an invitation and hand the email to the worker.
   *
   * The raw link is returned exactly once, here. A queue or provider failure
   * never undoes the invitation: it stays in the list with an email status the
   * owner can act on (AC-4).
   */
  async invite(
    businessId: string,
    actorUserId: string,
    request: InviteCreateRequest,
  ): Promise<{
    invitation: TeamInvitation;
    inviteUrl: string;
    emailStatus: TeamInvitation['emailStatus'];
    emailError: string | null;
  }> {
    const email = normaliseEmail(request.email);
    if (email === '') throw new ValidationError(['email'], 'Enter an email address');

    const existingMember = await this.teamRepository.findMemberByEmail(businessId, email);
    if (existingMember) throw new InviteAlreadyMemberError();

    const live = await this.teamRepository.findLiveInvitationByEmail(businessId, email);
    if (live) {
      // A waiting invitation is a conflict. An expired one is cancelled so the
      // new invitation can take its place (AC-11).
      if (invitationStatus(live, this.now()) === 'PENDING') {
        throw new InviteAlreadyPendingError(live.id);
      }
      await this.teamRepository.revokeInvitation(businessId, live.id, { userId: actorUserId });
    }

    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);

    let created: Invitation;
    try {
      created = await this.teamRepository.createInvitation({
        businessId,
        email,
        // Every invitation grants STAFF; ownership is changed after joining (AC-1).
        role: 'STAFF',
        tokenHash,
        invitedByUserId: actorUserId,
        expiresAt: expiryFromNow(this.now()),
      });
    } catch (error) {
      // The partial unique index is the last word on one live invite per email,
      // which protects against two owners clicking at the same moment.
      if (isUniqueViolation(error)) {
        // Another owner won the race. Report the live invitation so the screen
        // can point at it instead of showing a conflict with no target.
        const pending = await this.teamRepository.findLiveInvitationByEmail(businessId, email);
        throw new InviteAlreadyPendingError(pending?.id);
      }
      throw error;
    }

    // The membership check above can lose to an accept committing while this
    // invitation is inserted. Re-read the membership and undo the fresh row, so
    // a person who just joined never gets a pending invite and a dead link.
    // The create and revoke audits this leaves behind are deliberate: the trail
    // records what happened even though the invitation is never shown.
    const becameMember = await this.teamRepository.findMemberByEmail(businessId, email);
    if (becameMember) {
      await this.teamRepository.revokeInvitation(businessId, created.id, { userId: actorUserId });
      throw new InviteAlreadyMemberError();
    }

    const settled = await this.settleSend(created, token);
    const listed = await this.teamRepository.findInvitationById(businessId, created.id);

    return {
      invitation: toInvitationDto(
        listed ?? { ...created, invitedByName: await this.inviterName(actorUserId) },
        this.now(),
      ),
      inviteUrl: buildInviteUrl(this.appOrigin, token),
      emailStatus: settled.status,
      emailError: settled.error,
    };
  }

  /**
   * Send a fresh link. The old token stops working immediately because only one
   * hash exists per invitation, and the expiry moves seven days out (AC-12).
   */
  async resend(
    businessId: string,
    actorUserId: string,
    invitationId: string,
  ): Promise<{
    invitation: TeamInvitation;
    inviteUrl: string;
    emailStatus: TeamInvitation['emailStatus'];
    emailError: string | null;
  }> {
    const existing = await this.teamRepository.findInvitationById(businessId, invitationId);
    if (!existing || existing.acceptedAt || existing.revokedAt) {
      throw new InviteNotFoundError();
    }

    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);
    const rotated = await this.teamRepository.rotateInvitation(
      businessId,
      invitationId,
      tokenHash,
      expiryFromNow(this.now()),
      { userId: actorUserId },
      // The hash read just above is the one a concurrent send may already have
      // replaced, so the rotate itself decides who is live.
      existing.tokenHash,
    );
    if (!rotated) {
      // Either the invitation was accepted or cancelled between the read and the
      // rotate, or another resend replaced the link first. Re-read to tell those
      // apart: if it is still live the link this call generated was never
      // stored, so answering success would hand out a dead link.
      const current = await this.teamRepository.findInvitationById(businessId, invitationId);
      if (!current || current.acceptedAt || current.revokedAt) {
        throw new InviteNotFoundError();
      }
      throw new InviteResendConflictError();
    }

    const settled = await this.settleSend(rotated, token);
    const listed = await this.teamRepository.findInvitationById(businessId, rotated.id);

    return {
      invitation: toInvitationDto(
        listed ?? { ...rotated, invitedByName: existing.invitedByName },
        this.now(),
      ),
      inviteUrl: buildInviteUrl(this.appOrigin, token),
      emailStatus: settled.status,
      emailError: settled.error,
    };
  }

  async cancel(businessId: string, actorUserId: string, invitationId: string): Promise<void> {
    const revoked = await this.teamRepository.revokeInvitation(businessId, invitationId, {
      userId: actorUserId,
    });
    if (!revoked) throw new InviteNotFoundError();
  }

  /** Promote or demote a member, never the last owner and never yourself (AC-14). */
  async changeRole(
    businessId: string,
    actorUserId: string,
    membershipId: string,
    role: TeamRole,
  ): Promise<TeamMember> {
    const member = await this.teamRepository.findMemberById(businessId, membershipId);
    if (!member) throw new TeamMemberNotFoundError();
    if (member.userId === actorUserId) throw new SelfChangeNotAllowedError();
    if (member.role === role) return toMemberDto(member);

    if (member.role === 'OWNER' && role === 'STAFF') {
      // A cheap pre check so an obvious last owner demotion never opens a
      // transaction. The repository is authoritative and repeats the count
      // under the business row lock, which is what makes concurrent demotions
      // safe.
      const owners = await this.teamRepository.countOwners(businessId);
      if (owners <= 1) throw new LastOwnerError();
    }

    const updated = await this.teamRepository.updateMemberRole(businessId, membershipId, role, {
      userId: actorUserId,
    });
    if (!updated) throw new TeamMemberNotFoundError();
    return toMemberDto(updated);
  }

  /** Remove a member. The next request from them is refused (AC-15). */
  async removeMember(businessId: string, actorUserId: string, membershipId: string): Promise<void> {
    const member = await this.teamRepository.findMemberById(businessId, membershipId);
    if (!member) throw new TeamMemberNotFoundError();
    if (member.userId === actorUserId) throw new SelfChangeNotAllowedError();

    if (member.role === 'OWNER') {
      // Same pre check as a role change: the repository repeats it under the
      // business row lock, so this only skips an obvious doomed transaction.
      const owners = await this.teamRepository.countOwners(businessId);
      if (owners <= 1) throw new LastOwnerError();
    }

    const removed = await this.teamRepository.removeMember(businessId, membershipId, {
      userId: actorUserId,
    });
    if (!removed) throw new TeamMemberNotFoundError();
  }

  /**
   * What an invitee sees before signing in: the business, who invited them, the
   * address the invitation is for, and whether they already have an account.
   */
  async preview(token: string): Promise<InvitePreview> {
    const tokenHash = hashInviteToken(token);
    const context = await this.teamRepository.findInvitationByTokenHash(tokenHash);
    if (!context) throw new InviteNotFoundError();

    const { invitation } = context;
    this.assertUsable(invitation);

    const existingUser = await this.authRepository.findUserByEmail(invitation.email);
    const existingMember = await this.teamRepository.findMemberByEmail(
      invitation.businessId,
      invitation.email,
    );

    return {
      businessName: context.businessName,
      inviterName: context.inviterName,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      timezone: context.businessTimezone,
      accountExists: existingUser !== null,
      hasPassword: Boolean(existingUser?.passwordHash),
      alreadyMember: existingMember !== null,
    };
  }

  /**
   * Accept an invitation.
   *
   * A signed in caller must own the invited address. An anonymous caller may
   * create the account the invitation is for, or set the first password on an
   * account that has none. An account that already has a password has to sign
   * in first, so accepting can never be a password reset (AC-7, AC-8, AC-9).
   */
  async accept(
    token: string,
    request: InviteAcceptRequest,
    callerUserId: string | undefined,
  ): Promise<IssuedTokens> {
    const tokenHash = hashInviteToken(token);
    const context = await this.teamRepository.findInvitationByTokenHash(tokenHash);
    if (!context) throw new InviteNotFoundError();

    const { invitation } = context;
    this.assertUsable(invitation);

    const existingUser = await this.authRepository.findUserByEmail(invitation.email);
    const existingMember = await this.teamRepository.findMemberByEmail(
      invitation.businessId,
      invitation.email,
    );
    if (existingMember) throw new InviteAlreadyMemberError();

    let userId: string | undefined;
    let passwordHash: string | undefined;
    let callerHasPassword = false;

    if (callerUserId) {
      const caller = await this.authRepository.findUserById(callerUserId);
      if (!caller) throw new UnauthorizedError('Sign in again to accept this invitation');
      if (normaliseEmail(caller.email) !== invitation.email) throw new EmailMismatchError();
      userId = caller.id;
      callerHasPassword = Boolean(caller.passwordHash);
      // A signed in account that still has no password must set one now. Without
      // it the membership would be active but unusable once the tokens expire,
      // because there is no later invitation to set a first password.
      if (!callerHasPassword && !request.password) {
        throw new ValidationError(
          ['password'],
          'Choose a password to finish setting up your account',
        );
      }
    } else if (existingUser) {
      if (existingUser.passwordHash) throw new SignInRequiredError();
      if (!request.password) {
        throw new ValidationError(
          ['password'],
          'Choose a password to finish setting up your account',
        );
      }
      userId = existingUser.id;
    } else if (!request.password) {
      throw new ValidationError(['password'], 'Choose a password to create your account');
    }

    // A signed in caller with an account that already has a password accepts
    // with the bearer token alone. Setting a password stays allowed for a new
    // account or one that has none yet (AC-8, AC-9).
    const maySetPassword = !callerUserId || !callerHasPassword;
    if (maySetPassword && request.password) {
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(request.password, salt);
    }

    // A new account needs a name. The invitation address is the last resort so
    // the member list never shows a blank.
    const fallbackName = invitation.email.split('@')[0] ?? invitation.email;
    let result: AcceptResult;
    try {
      result = await this.teamRepository.acceptInvitation({
        invitationId: invitation.id,
        tokenHash,
        name: fallbackName,
        requestedName: maySetPassword ? request.name?.trim() || undefined : undefined,
        passwordHash,
        existingUserId: userId,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const constraint = uniqueViolationConstraint(error);
      // Two invitations for one address can race to create the account. The
      // loser joins the account that won instead of reporting a membership
      // conflict that a retry would resolve.
      if (constraint !== 'users_email_lower_unq' && constraint !== 'users_email_unique') {
        throw new InviteAlreadyMemberError();
      }

      const winner = await this.authRepository.findUserByEmail(invitation.email);
      if (!winner) throw new InviteAlreadyMemberError();
      // The winning account may already have a password. Never replace it with
      // one a different accept request supplied; ask that caller to sign in.
      if (!callerUserId && winner.passwordHash) throw new SignInRequiredError();

      const winnerMaySetPassword = !callerUserId || !winner.passwordHash;
      try {
        result = await this.teamRepository.acceptInvitation({
          invitationId: invitation.id,
          tokenHash,
          name: fallbackName,
          requestedName: winnerMaySetPassword ? request.name?.trim() || undefined : undefined,
          passwordHash: winnerMaySetPassword ? passwordHash : undefined,
          existingUserId: winner.id,
        });
      } catch (retryError) {
        if (isUniqueViolation(retryError)) throw new InviteAlreadyMemberError();
        throw retryError;
      }
    }

    const tokens = await this.tokenIssuer.issueTokensForUser(result.userId, result.businessId);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      businessId: result.businessId,
    };
  }

  private assertUsable(invitation: Invitation): void {
    if (invitation.revokedAt) throw new InviteRevokedError();
    if (invitation.acceptedAt) throw new InviteAlreadyAcceptedError();
    if (invitationStatus(invitation, this.now()) === 'EXPIRED') throw new InviteExpiredError();
  }

  /**
   * Queue the email and record what happened to it. No provider in this
   * environment means the invitation is kept and marked skipped.
   */
  private async settleSend(
    invitation: Invitation,
    token: string,
  ): Promise<{ status: TeamInvitation['emailStatus']; error: string | null }> {
    if (!this.emailDelivery.isConfigured()) {
      await this.teamRepository.markEmailSkipped(invitation.id, invitation.tokenHash);
      return { status: 'SKIPPED', error: null };
    }

    const queued = await this.emailQueue.enqueue({
      invitationId: invitation.id,
      tokenHash: invitation.tokenHash,
      token,
    });

    if (!queued) {
      await this.teamRepository.markEmailFailed(
        invitation.id,
        invitation.tokenHash,
        'QUEUE_UNAVAILABLE',
      );
      return { status: 'FAILED', error: 'QUEUE_UNAVAILABLE' };
    }

    return { status: 'QUEUED', error: null };
  }

  private async inviterName(userId: string): Promise<string> {
    const user = await this.authRepository.findUserById(userId);
    return user?.name ?? 'A team owner';
  }
}
