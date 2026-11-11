import { INVITE_JOB_ATTEMPTS, type InviteEmailJobData } from './invite-job.js';
import { ITeamRepository } from '../../domain/repositories/team.repository.js';
import { IAuthRepository } from '../../domain/repositories/auth.repository.js';
import { EMAIL_NOT_CONFIGURED } from '../../domain/errors.js';
import { hashesMatch } from '../../domain/invitation-token.js';
import type { InviteEmailContent, SendResult } from './invite-email.port.js';

export interface InviteWorkerDeps {
  teamRepository: ITeamRepository;
  authRepository: IAuthRepository;
  send: (content: InviteEmailContent, idempotencyKey: string) => Promise<SendResult>;
  /** The configured reply address, or undefined to fall back to the inviter. */
  emailReplyTo: string | undefined;
  /** Builds the public invite link without the worker knowing the host rules. */
  buildInviteUrl: (token: string) => string;
  now: () => Date;
}

/**
 * Provider failures that cannot succeed by sending the same email again. They
 * end the job on the first attempt instead of burning the 1/2/4 minute backoff.
 */
const PERMANENT_EMAIL_ERRORS = new Set([EMAIL_NOT_CONFIGURED, 'PROVIDER_UNAUTHORIZED']);

function isPermanentEmailError(errorCode: string | undefined): boolean {
  return errorCode !== undefined && PERMANENT_EMAIL_ERRORS.has(errorCode);
}

export interface InviteJobOutcome {
  outcome: 'SENT' | 'SKIPPED' | 'RETRY' | 'FAILED' | 'IGNORED';
  reason?: string;
}

/**
 * One attempt at one invitation email.
 *
 * The invitation is re-read from the database first, so a job that outlived its
 * invitation (cancelled, accepted, resent, expired) does nothing. A retry is
 * only asked for when the provider might succeed next time.
 */
export async function processInviteEmailJob(
  deps: InviteWorkerDeps,
  data: InviteEmailJobData,
  attemptNumber: number,
): Promise<InviteJobOutcome> {
  try {
    return await attemptInviteEmail(deps, data, attemptNumber);
  } catch (error) {
    // An unexpected throw still ends the job, and only this path lands here:
    // the normal failure path records the provider reason. On the last attempt
    // the row must not stay QUEUED forever, so store the generic code instead.
    if (attemptNumber >= INVITE_JOB_ATTEMPTS) {
      await deps.teamRepository
        .markEmailFailed(data.invitationId, data.tokenHash, 'EMAIL_SEND_FAILED')
        .catch(() => undefined);
    }
    throw error;
  }
}

async function attemptInviteEmail(
  deps: InviteWorkerDeps,
  data: InviteEmailJobData,
  attemptNumber: number,
): Promise<InviteJobOutcome> {
  const context = await deps.teamRepository.findInvitationByTokenHash(data.tokenHash);
  if (!context) {
    // The token was rotated or the invitation deleted: this job is stale.
    return { outcome: 'IGNORED', reason: 'TOKEN_CHANGED' };
  }

  const { invitation } = context;
  if (invitation.id !== data.invitationId) {
    return { outcome: 'IGNORED', reason: 'TOKEN_CHANGED' };
  }
  if (!hashesMatch(invitation.tokenHash, data.tokenHash)) {
    return { outcome: 'IGNORED', reason: 'TOKEN_CHANGED' };
  }
  if (invitation.acceptedAt) return { outcome: 'IGNORED', reason: 'ACCEPTED' };
  if (invitation.revokedAt) return { outcome: 'IGNORED', reason: 'REVOKED' };
  // A failed or skipped row is never legitimate to send. This closes the race
  // where the create request timed out, marked the row FAILED, and the late job
  // still reached the provider.
  if (invitation.emailStatus !== 'QUEUED') {
    return { outcome: 'IGNORED', reason: 'EMAIL_NOT_QUEUED' };
  }
  if (invitation.expiresAt.getTime() <= deps.now().getTime()) {
    await deps.teamRepository.markEmailFailed(invitation.id, data.tokenHash, 'INVITE_EXPIRED');
    return { outcome: 'FAILED', reason: 'INVITE_EXPIRED' };
  }

  // An accept can finish after this job was queued. The address already has
  // access, so never send the link and never leave the row waiting.
  const alreadyMember = await deps.teamRepository.findMemberByEmail(
    invitation.businessId,
    invitation.email,
  );
  if (alreadyMember) {
    // The revoke audit names the inviter as the actor even though the worker
    // made the change. As with the same race in the create path, the trail
    // records what happened: the invite is gone because the person joined.
    await deps.teamRepository.revokeInvitation(invitation.businessId, invitation.id, {
      userId: invitation.invitedByUserId,
    });
    return { outcome: 'IGNORED', reason: 'ALREADY_MEMBER' };
  }

  const inviter = await deps.authRepository.findUserById(invitation.invitedByUserId);

  const result = await deps.send(
    {
      to: invitation.email,
      businessName: context.businessName,
      inviterName: inviter?.name ?? context.inviterName,
      role: invitation.role,
      inviteUrl: deps.buildInviteUrl(data.token),
      expiresAt: invitation.expiresAt,
      replyTo: deps.emailReplyTo || inviter?.email,
    },
    `invite:${invitation.id}:${invitation.tokenHash}`,
  );

  await deps.teamRepository.setEmailAttempts(invitation.id, data.tokenHash, attemptNumber);

  if (result.ok) {
    await deps.teamRepository.markEmailSent(invitation.id, data.tokenHash);
    return { outcome: 'SENT' };
  }

  if (!isPermanentEmailError(result.errorCode) && attemptNumber < INVITE_JOB_ATTEMPTS) {
    return { outcome: 'RETRY', reason: result.errorCode };
  }

  const reason = result.errorCode ?? 'EMAIL_SEND_FAILED';
  await deps.teamRepository.markEmailFailed(invitation.id, data.tokenHash, reason);
  return { outcome: 'FAILED', reason };
}
