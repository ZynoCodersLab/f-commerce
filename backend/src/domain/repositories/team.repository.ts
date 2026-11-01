import {
  Invitation,
  InvitationEmailStatus,
  InvitationRole,
} from '../entities/invitation.entity.js';

/** A member row joined with the account it points at. */
export interface TeamMemberRecord {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: InvitationRole;
  joinedAt: Date;
}

/** An invitation row joined with the inviter's name. */
export interface TeamInvitationRecord extends Invitation {
  invitedByName: string;
}

/** Everything the accept step needs about an invitation and its target. */
export interface InvitationContext {
  invitation: Invitation;
  businessName: string;
  inviterName: string;
}

export type InvitationState = 'PENDING' | 'EXPIRED' | 'ACCEPTED' | 'REVOKED';

export interface NewInvitationData {
  businessId: string;
  email: string;
  role: InvitationRole;
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: Date;
}

export interface AcceptResult {
  membershipId: string;
  userId: string;
  businessId: string;
  role: InvitationRole;
}

/**
 * Persistence for the team screen and the invite flow. Every method is
 * business scoped except the token lookups, which are public and find the
 * invite by its hash alone.
 */
export interface ITeamRepository {
  /** Active members, owners first, then by name. */
  listMembers(businessId: string): Promise<TeamMemberRecord[]>;
  /** Live invitations (pending or expired), newest first. */
  listInvitations(businessId: string): Promise<TeamInvitationRecord[]>;
  countOwners(businessId: string): Promise<number>;
  findMemberById(businessId: string, membershipId: string): Promise<TeamMemberRecord | null>;
  findMemberByEmail(businessId: string, email: string): Promise<TeamMemberRecord | null>;
  findInvitationById(
    businessId: string,
    invitationId: string,
  ): Promise<TeamInvitationRecord | null>;
  /** The live invitation for an email, if one is waiting. */
  findLiveInvitationByEmail(businessId: string, email: string): Promise<Invitation | null>;
  /** A token lookup that includes accepted and revoked rows, so the caller can explain why. */
  findInvitationByTokenHash(tokenHash: string): Promise<InvitationContext | null>;
  createInvitation(data: NewInvitationData): Promise<Invitation>;
  /** Replace the token and expiry of an existing invitation and queue a new send. */
  rotateInvitation(
    businessId: string,
    invitationId: string,
    tokenHash: string,
    expiresAt: Date,
    audit: { userId: string },
  ): Promise<Invitation | null>;
  revokeInvitation(
    businessId: string,
    invitationId: string,
    audit: { userId: string },
  ): Promise<boolean>;
  markEmailSent(invitationId: string, tokenHash: string): Promise<boolean>;
  markEmailFailed(invitationId: string, tokenHash: string, reason: string): Promise<boolean>;
  markEmailSkipped(invitationId: string, tokenHash: string): Promise<boolean>;
  setEmailAttempts(invitationId: string, attempts: number): Promise<void>;
  updateMemberRole(
    businessId: string,
    membershipId: string,
    role: InvitationRole,
    audit: { userId: string },
  ): Promise<TeamMemberRecord | null>;
  removeMember(
    businessId: string,
    membershipId: string,
    audit: { userId: string },
  ): Promise<boolean>;
  /**
   * Accept an invitation in one transaction: lock the row, create or reuse the
   * account, activate the membership, mark the invitation accepted, and audit.
   */
  acceptInvitation(input: {
    invitationId: string;
    email: string;
    role: InvitationRole;
    name: string;
    passwordHash?: string;
    existingUserId?: string;
    existingUserName?: string;
    accountExists: boolean;
  }): Promise<AcceptResult>;
}

export type { Invitation, InvitationEmailStatus };
