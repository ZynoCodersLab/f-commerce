import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Options } from 'express-rate-limit';

import { RedisRateLimitStore } from './invite-rate-limit.middleware.js';

/**
 * Guards the counter against the Redis 7 only `PEXPIRE ... NX` transaction.
 *
 * The shared counter is one atomic script, so a Redis 6 server still sets a
 * TTL. A fake client with only `eval` fails the old multi based code into the
 * in process fallback, which is why the expected total below is the script
 * reply and not 1.
 */
describe('RedisRateLimitStore', () => {
  it('counts with the atomic script and honours its reply', async () => {
    const evalMock = vi.fn().mockResolvedValue([3, 42_000]);
    const redis = { eval: evalMock } as unknown as Redis;
    const store = new RedisRateLimitStore(redis, 'unit');
    store.init({ windowMs: 60_000 } as Options);

    const result = await store.increment('owner-a');

    expect(result.totalHits).toBe(3);
    expect(result.resetTime?.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(evalMock).toHaveBeenCalledTimes(1);
    expect(evalMock.mock.calls[0]?.[1]).toBe(1);
  });
});
