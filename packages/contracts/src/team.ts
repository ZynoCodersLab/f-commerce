import { z } from 'zod';

/** Roles a membership can hold. */
export const TeamRoleEnum = z.enum(['OWNER', 'STAFF']);
export type TeamRole = z.infer<typeof TeamRoleEnum>;

/** Membership states. `INVITED` is legacy and never authorizes a request. */
export const TeamMemberStatusEnum = z.enum(['ACTIVE', 'REMOVED']);
export type TeamMemberStatus = z.infer<typeof TeamMemberStatusEnum>;

/** How an invitation's email delivery stands. */
export const InviteEmailStatusEnum = z.enum(['QUEUED', 'SENT', 'FAILED', 'SKIPPED']);
export type InviteEmailStatus = z.infer<typeof InviteEmailStatusEnum>;

/** Action codes recorded when the team changes. */
export const TeamAuditAction = {
  INVITE_CREATED: 'TEAM_INVITE_CREATED',
  INVITE_RESENT: 'TEAM_INVITE_RESENT',
  INVITE_REVOKED: 'TEAM_INVITE_REVOKED',
  INVITE_ACCEPTED: 'TEAM_INVITE_ACCEPTED',
  ROLE_CHANGED: 'TEAM_ROLE_CHANGED',
  MEMBER_REMOVED: 'TEAM_MEMBER_REMOVED',
} as const;

export type TeamAuditActionType = (typeof TeamAuditAction)[keyof typeof TeamAuditAction];

/** Audit entity types written by the team feature. */
export const TeamAuditEntity = {
  INVITATION: 'Invitation',
  BUSINESS_MEMBER: 'BusinessMember',
} as const;

export type TeamAuditEntityType = (typeof TeamAuditEntity)[keyof typeof TeamAuditEntity];

/** Error codes returned by the team and invitation endpoints. */
export const TeamErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVITE_ALREADY_MEMBER: 'INVITE_ALREADY_MEMBER',
  INVITE_ALREADY_PENDING: 'INVITE_ALREADY_PENDING',
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  INVITE_REVOKED: 'INVITE_REVOKED',
  INVITE_ALREADY_ACCEPTED: 'INVITE_ALREADY_ACCEPTED',
  SIGN_IN_REQUIRED: 'SIGN_IN_REQUIRED',
  EMAIL_MISMATCH: 'EMAIL_MISMATCH',
  LAST_OWNER: 'LAST_OWNER',
  SELF_CHANGE_NOT_ALLOWED: 'SELF_CHANGE_NOT_ALLOWED',
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  BUSINESS_ACCESS_DENIED: 'BUSINESS_ACCESS_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type TeamErrorCodeType = (typeof TeamErrorCode)[keyof typeof TeamErrorCode];

/**
 * An email address as the team feature stores it: trimmed and lowercased, so
 * the same person cannot hold two accounts or two invitations that differ only
 * in case.
 */
export const TeamEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email('Enter a valid email address').max(254));

export const InviteCreateSchema = z.object({
  email: TeamEmailSchema,
  role: TeamRoleEnum.default('STAFF').optional(),
});

export const InviteAcceptSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120).optional(),
  /**
   * Required only when the invitation creates an account or fills in a
   * password for an account that has none. The service enforces that rule
   * because the body shape alone cannot express it.
   */
  password: z.string().min(8, 'Password must be at least 8 characters').max(128).optional(),
});

export const MemberRoleUpdateSchema = z.object({
  role: TeamRoleEnum,
});

const isoDate = z.string();

export const TeamMemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: TeamRoleEnum,
  joinedAt: isoDate,
});

export const TeamInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: TeamRoleEnum,
  invitedByName: z.string(),
  sentAt: isoDate.nullable(),
  createdAt: isoDate,
  expiresAt: isoDate,
  status: z.enum(['PENDING', 'EXPIRED']),
  emailStatus: InviteEmailStatusEnum,
  emailError: z.string().nullable(),
});

export const TeamListResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    members: z.array(TeamMemberSchema),
    invitations: z.array(TeamInvitationSchema),
  }),
  message: z.string(),
});

export const InviteCreateResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    invitation: TeamInvitationSchema,
    inviteUrl: z.string(),
    emailStatus: InviteEmailStatusEnum,
    emailError: z.string().nullable(),
  }),
  message: z.string(),
});

export const InviteResendResponseSchema = InviteCreateResponseSchema;

export const InvitePreviewSchema = z.object({
  businessName: z.string(),
  inviterName: z.string(),
  email: z.string(),
  role: TeamRoleEnum,
  expiresAt: isoDate,
  accountExists: z.boolean(),
  hasPassword: z.boolean(),
  alreadyMember: z.boolean(),
});

export const InvitePreviewResponseSchema = z.object({
  success: z.literal(true),
  data: InvitePreviewSchema,
  message: z.string(),
});

export const InviteAcceptResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    accessToken: z.string(),
    businessId: z.string(),
  }),
  message: z.string(),
});

export type InviteCreateRequest = z.infer<typeof InviteCreateSchema>;
export type InviteAcceptRequest = z.infer<typeof InviteAcceptSchema>;
export type MemberRoleUpdateRequest = z.infer<typeof MemberRoleUpdateSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamInvitation = z.infer<typeof TeamInvitationSchema>;
export type TeamListResponse = z.infer<typeof TeamListResponseSchema>;
export type InviteCreateResponse = z.infer<typeof InviteCreateResponseSchema>;
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;
export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponseSchema>;
export type InviteAcceptResponse = z.infer<typeof InviteAcceptResponseSchema>;
