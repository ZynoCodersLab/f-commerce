import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Options } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { MemoryFallbackStore } from './memory-fallback-store.js';
import { RedisRateLimitStore } from './invite-rate-limit.middleware.js';

// The token limiters hand a raw bearer secret to the store as the key. When
// Redis is down the store falls back to an in-process map, which must hold the
// same opaque hash the Redis path would, never the raw token. This pins that.

function failingRedis(): Redis {
  return {
    eval: () => Promise.reject(new Error('redis is down')),
  } as unknown as Redis;
}

describe('RedisRateLimitStore fallback key hygiene', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts a raw token under its hashed key and never the raw secret', async () => {
    const incrementSpy = vi.spyOn(MemoryFallbackStore.prototype, 'increment');
    const store = new RedisRateLimitStore(failingRedis(), 'invite-preview');
    store.init({ windowMs: 60_000 } as Options);

    const rawKey = 'token:raw-invite-secret';
    const result = await store.increment(rawKey);

    const hashed = `ratelimit:invite-preview:${createHash('sha256').update(rawKey).digest('hex')}`;
    expect(incrementSpy).toHaveBeenCalledWith(hashed);
    expect(incrementSpy).not.toHaveBeenCalledWith(rawKey);
    expect(result.totalHits).toBe(1);
  });
});
