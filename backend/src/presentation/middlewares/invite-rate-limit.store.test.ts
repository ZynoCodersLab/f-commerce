import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Options } from 'express-rate-limit';

import { RedisRateLimitStore, closeRateLimitStore } from './redis-rate-limit-store.js';

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

  it('falls back to the local counter when Redis returns an unexpected reply shape', async () => {
    const evalMock = vi.fn().mockResolvedValue(['bad', null]);
    const redis = { eval: evalMock } as unknown as Redis;
    const store = new RedisRateLimitStore(redis, 'malformed-reply');
    store.init({ windowMs: 60_000 } as Options);

    const first = await store.increment('owner-a');
    const second = await store.increment('owner-a');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
  });

  it('falls back to local decrement, resetKey, and resetAll when Redis fails', async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error('redis down')),
      del: vi.fn().mockRejectedValue(new Error('redis down')),
      scan: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as Redis;
    const store = new RedisRateLimitStore(redis, 'offline-ops');
    store.init({ windowMs: 60_000 } as Options);

    await store.increment('owner-a');
    await store.increment('owner-a');
    await store.decrement('owner-a');
    expect((await store.increment('owner-a')).totalHits).toBe(2);

    await store.resetKey('owner-a');
    expect((await store.increment('owner-a')).totalHits).toBe(1);

    await store.resetAll();
    expect((await store.increment('owner-a')).totalHits).toBe(1);
  });

  it('resolves cleanly when closing the store before any client is created', async () => {
    await expect(closeRateLimitStore()).resolves.toBeUndefined();
  });
});
