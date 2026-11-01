import { createRedisConnection } from './infrastructure/queue/redis-connection.js';
import { closeInviteQueue } from './infrastructure/queue/invite-queue.js';
import { createInviteWorker } from './application/services/invite-worker.js';
import {
  closeDatabase,
  verifyDatabaseConnection,
} from './infrastructure/database/drizzle/client.js';
import { config, productionEmailProblems } from './infrastructure/config.js';

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
      await closeInviteQueue();
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
