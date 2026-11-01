import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  InviteEmailJobData,
  INVITE_JOB_ATTEMPTS,
  INVITE_QUEUE_NAME,
} from '../../infrastructure/queue/invite-queue.js';
import { config } from '../../infrastructure/config.js';
import { DrizzleTeamRepository } from '../../infrastructure/database/drizzle/repositories/team.repository.js';
import { DrizzleAuthRepository } from '../../infrastructure/database/drizzle/repositories/auth.repository.js';
import { getDb } from '../../infrastructure/database/drizzle/client.js';
import { businesses } from '../../infrastructure/database/drizzle/schema.js';
import { eq } from 'drizzle-orm';
import { ITeamRepository } from '../../domain/repositories/team.repository.js';
import { IAuthRepository } from '../../domain/repositories/auth.repository.js';
import { hashesMatch } from '../../domain/invitation-token.js';
import { inviteUrlFor } from '../../infrastructure/services/invite-email.js';
import { sendInviteEmail } from '../../infrastructure/services/resend-email.service.js';

export interface InviteWorkerDeps {
  teamRepository: ITeamRepository;
  authRepository: IAuthRepository;
  send: typeof sendInviteEmail;
  businessName: (businessId: string) => Promise<string | null>;
  appOrigin: string;
  now: () => Date;
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
  if (invitation.expiresAt.getTime() <= deps.now().getTime()) {
    await deps.teamRepository.markEmailFailed(invitation.id, data.tokenHash, 'INVITE_EXPIRED');
    return { outcome: 'FAILED', reason: 'INVITE_EXPIRED' };
  }

  const inviter = await deps.authRepository.findUserById(invitation.invitedByUserId);

  const result = await deps.send(
    {
      to: invitation.email,
      businessName: context.businessName,
      inviterName: inviter?.name ?? context.inviterName,
      role: invitation.role,
      inviteUrl: inviteUrlFor(deps.appOrigin, data.token),
      expiresAt: invitation.expiresAt,
      replyTo: config.EMAIL_REPLY_TO || inviter?.email,
    },
    `invite:${invitation.id}:${invitation.tokenHash}`,
  );

  await deps.teamRepository.setEmailAttempts(invitation.id, attemptNumber);

  if (result.ok) {
    await deps.teamRepository.markEmailSent(invitation.id, data.tokenHash);
    return { outcome: 'SENT' };
  }

  if (attemptNumber < INVITE_JOB_ATTEMPTS) {
    return { outcome: 'RETRY', reason: result.errorCode };
  }

  const reason = result.errorCode ?? 'EMAIL_SEND_FAILED';
  await deps.teamRepository.markEmailFailed(invitation.id, data.tokenHash, reason);
  return { outcome: 'FAILED', reason };
}

async function businessNameFor(businessId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return rows[0]?.name ?? null;
}

export function createInviteWorker(connection: Redis): Worker<InviteEmailJobData> {
  const deps: InviteWorkerDeps = {
    teamRepository: new DrizzleTeamRepository(),
    authRepository: new DrizzleAuthRepository(),
    send: sendInviteEmail,
    businessName: businessNameFor,
    appOrigin: config.APP_ORIGIN,
    now: () => new Date(),
  };

  const worker = new Worker<InviteEmailJobData>(
    INVITE_QUEUE_NAME,
    async (job: Job<InviteEmailJobData>) => {
      const attempt = job.attemptsMade + 1;
      const outcome = await processInviteEmailJob(deps, job.data, attempt);
      if (outcome.outcome === 'RETRY') {
        // A real failure so BullMQ applies the backoff and keeps the attempt count.
        throw new Error(`Invitation email attempt ${attempt} failed: ${outcome.reason}`);
      }
      return outcome.outcome;
    },
    { connection, concurrency: 4 },
  );

  worker.on('failed', (job, error) => {
    // Job ids and addresses are safe to log; the token never is.
    console.error(`Invitation email job ${job?.id ?? 'unknown'} failed:`, error.message);
  });

  worker.on('stalled', (jobId) => {
    console.error(`Invitation email job ${jobId} stalled and will be retried.`);
  });

  return worker;
}
