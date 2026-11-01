import { Queue, QueueEvents } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { createRedisConnection } from './redis-connection.js';

/** The single queue invitations travel through. */
export const INVITE_QUEUE_NAME = 'invitation-email';

/** What a job carries. The raw token lives here only while the job is pending. */
export interface InviteEmailJobData {
  invitationId: string;
  tokenHash: string;
  /** The plain token. Removed from Redis once the job settles (AC-20). */
  token: string;
}

/** The first attempt plus three retries, at 1, 2 and 4 minutes (AC-3). */
export const INVITE_JOB_ATTEMPTS = 4;

export const INVITE_JOB_BACKOFF_MS = 60_000;

/**
 * Job options. A settled job is deleted rather than kept, because its payload
 * holds the raw invite token.
 */
export function inviteJobOptions(invitationId: string, tokenHash: string): JobsOptions {
  return {
    attempts: INVITE_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: INVITE_JOB_BACKOFF_MS },
    removeOnComplete: true,
    removeOnFail: true,
    // The same invitation and token never need a second copy in flight.
    jobId: `invite-${invitationId}-${tokenHash.slice(0, 12)}`,
  };
}

let queue: Queue<InviteEmailJobData> | null = null;
let queueEvents: QueueEvents | null = null;
const connections: { quit(): Promise<unknown> }[] = [];

function ensureQueue(): Queue<InviteEmailJobData> {
  if (queue) return queue;

  const producerConnection = createRedisConnection('producer');
  connections.push(producerConnection);

  queue = new Queue<InviteEmailJobData>(INVITE_QUEUE_NAME, {
    connection: producerConnection,
    defaultJobOptions: {
      attempts: INVITE_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: INVITE_JOB_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  const eventsConnection = createRedisConnection('producer');
  connections.push(eventsConnection);
  queueEvents = new QueueEvents(INVITE_QUEUE_NAME, { connection: eventsConnection });

  return queue;
}

/** How long a request waits for Redis before it gives up and moves on. */
const ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * Hand an invitation to the worker.
 *
 * A queue that is slow or unreachable must never lose the invitation itself:
 * the row is already saved, so this reports failure and the caller marks the
 * email as failed instead of returning an error (AC-4).
 */
export async function enqueueInviteEmail(data: InviteEmailJobData): Promise<boolean> {
  const active = ensureQueue();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Redis did not accept the job in time')),
        ENQUEUE_TIMEOUT_MS,
      );
    });

    await Promise.race([
      active.add('send-invitation', data, inviteJobOptions(data.invitationId, data.tokenHash)),
      timeout,
    ]);
    return true;
  } catch (error) {
    console.error('Could not queue an invitation email:', (error as Error).message);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Close the producer and its event stream. Used at shutdown and in tests. */
export async function closeInviteQueue(): Promise<void> {
  const open = [queue, queueEvents].filter((value): value is Queue | QueueEvents => value !== null);
  queue = null;
  queueEvents = null;
  await Promise.allSettled(open.map((value) => value.close()));
  await Promise.allSettled(connections.map((connection) => connection.quit()));
  connections.length = 0;
}
