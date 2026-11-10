import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisConnection } from './infrastructure/queue/redis-connection.js';
import { INVITE_QUEUE_NAME } from './infrastructure/queue/invite-queue.js';
import type { InviteEmailJobData } from './application/services/invite-job.js';
import { processInviteEmailJob } from './application/services/invite-worker.js';
import type { InviteWorkerDeps } from './application/services/invite-worker.js';
import { DrizzleTeamRepository } from './infrastructure/database/drizzle/repositories/team.repository.js';
import { DrizzleAuthRepository } from './infrastructure/database/drizzle/repositories/auth.repository.js';
import { sendInviteEmail } from './infrastructure/services/resend-email.service.js';
import { buildInviteUrl } from './domain/invitation-token.js';
import {
  closeDatabase,
  verifyDatabaseConnection,
} from './infrastructure/database/drizzle/client.js';
import { config, productionEmailProblems } from './infrastructure/config.js';

/**
 * Builds the invite worker together with its dependencies.
 *
 * This is the composition step, so it lives at the process entry point: the
 * application layer owns `processInviteEmailJob` and the injected `deps` only,
 * and never reaches for a Drizzle repository or the BullMQ `Worker` itself.
 */
function createInviteWorker(connection: Redis): Worker<InviteEmailJobData> {
  const deps: InviteWorkerDeps = {
    teamRepository: new DrizzleTeamRepository(),
    authRepository: new DrizzleAuthRepository(),
    send: sendInviteEmail,
    emailReplyTo: config.EMAIL_REPLY_TO,
    buildInviteUrl: (token) => buildInviteUrl(config.APP_ORIGIN, token),
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

/**
 * The invitation worker, a process of its own.
 *
 * Retries with a minutes long backoff must survive a deploy or a restart of the
 * API, so the worker runs separately and the API only ever adds jobs. It needs
 * the same database and Redis as the API, and in production it refuses to start
 * without an email provider (AC-23, AC-4).
 */
async function main(): Promise<void> {
  const problems = productionEmailProblems(config);
  if (problems.length > 0) {
    console.error('Worker cannot start:', problems.join(' '));
    process.exitCode = 1;
    return;
  }

  await verifyDatabaseConnection();

  const connection = createRedisConnection('worker');
  const worker = createInviteWorker(connection);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Invitation worker received ${signal}, finishing in flight jobs.`);

    // Stop taking work, let a running job finish, then close everything.
    const deadline = setTimeout(() => {
      console.error('Invitation worker shutdown timed out.');
      process.exit(1);
    }, 10_000);
    deadline.unref();

    try {
      await worker.close();
      await connection.quit();
      await closeDatabase();
    } finally {
      clearTimeout(deadline);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  worker.on('ready', () => {
    console.log('Invitation worker is ready for jobs.');
  });

  console.log('Invitation worker started.');
}

main().catch((error: unknown) => {
  console.error('Invitation worker failed to start:', error);
  process.exit(1);
});
