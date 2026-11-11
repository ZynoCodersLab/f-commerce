import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const add = vi.fn();
  const closeQueue = vi.fn(() => Promise.resolve());
  const quit = vi.fn(() => Promise.resolve());
  return { add, closeQueue, quit };
});

// The queue class is constructed with `new`, so the mock implementation must
// be a regular function rather than an arrow.
vi.mock('bullmq', () => ({
  Queue: vi.fn(function Queue() {
    return { add: mocks.add, close: mocks.closeQueue };
  }),
}));

vi.mock('./redis-connection.js', () => ({
  createRedisConnection: vi.fn(function createRedisConnection() {
    return { quit: mocks.quit };
  }),
}));

import {
  INVITE_JOB_BACKOFF_MS,
  closeInviteQueue,
  enqueueInviteEmail,
  inviteJobOptions,
} from './invite-queue.js';

const JOB = {
  invitationId: 'invitation-1',
  tokenHash: 'token-hash',
  token: 'raw-token',
};

describe('enqueueInviteEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await closeInviteQueue();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports success when Redis accepts the job in time', async () => {
    mocks.add.mockResolvedValueOnce({ remove: vi.fn() });

    await expect(enqueueInviteEmail(JOB)).resolves.toBe(true);
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it('removes a job that lands after the request already gave up', async () => {
    let resolveAdd: (job: { remove: () => Promise<void> }) => void = () => {};
    mocks.add.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );
    const remove = vi.fn().mockResolvedValue(undefined);

    const result = enqueueInviteEmail(JOB);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();

    // Redis finally accepts the job. It must not be left for the worker.
    resolveAdd({ remove });
    await vi.advanceTimersByTimeAsync(0);

    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('inviteJobOptions', () => {
  it('pins the four attempts at 1, 2 and 4 minutes and the full token hash', () => {
    const tokenHash = 'a'.repeat(64);
    const options = inviteJobOptions('invitation-1', tokenHash);

    // The initial attempt plus three retries: 1, 2 and 4 minutes (AC-3).
    expect(options.attempts).toBe(4);
    expect(options.backoff).toEqual({ type: 'exponential', delay: INVITE_JOB_BACKOFF_MS });
    expect(INVITE_JOB_BACKOFF_MS).toBe(60_000);
    // The whole hash identifies the job, so two different links can never
    // collide on a shortened prefix.
    expect(options.jobId).toBe(`invite-invitation-1-${tokenHash}`);
    expect(options.removeOnComplete).toBe(true);
    expect(options.removeOnFail).toBe(true);
  });
});
