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

import { closeInviteQueue, enqueueInviteEmail } from './invite-queue.js';

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
