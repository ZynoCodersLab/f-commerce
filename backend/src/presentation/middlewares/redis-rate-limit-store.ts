import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Options, Store } from 'express-rate-limit';

import { config } from '../../infrastructure/config.js';
import { MemoryFallbackStore } from './memory-fallback-store.js';

/**
 * Count one hit, and start the window on the first hit.
 *
 * A plain INCR followed by `PEXPIRE key ms NX` needs Redis 7.0. On 6.x Redis
 * rejects the extra NX argument while it queues the transaction, so EXEC
 * aborts and every request falls back to the in process counter: the shared
 * limit silently disappears. One script does both steps atomically on every
 * Redis version the project supports, and it also repairs a counter that lost
 * its TTL for any other reason.
 */
const INCREMENT_SCRIPT = `
  local hits = redis.call('INCR', KEYS[1])
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  return {hits, ttl}
`;

/**
 * Undo one counted hit without ever creating a counter.
 *
 * A plain DECR on a missing key creates -1 with no expiry: the key then never
 * clears, and the next window's first increment starts at 0 and forgives a
 * real hit. This script only touches a key that exists, removes a legacy
 * negative value, and restores the window when a key somehow lost its TTL.
 */
const DECREMENT_SCRIPT = `
  local value = redis.call('GET', KEYS[1])
  if not value then return 0 end
  local nextValue = redis.call('DECR', KEYS[1])
  if nextValue < 0 then
    redis.call('DEL', KEYS[1])
    return 0
  end
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return nextValue
`;

/**
 * A counter shared by every API instance, because a limit that only counts
 * inside one process resets on every deploy and triples on three instances.
 *
 * When Redis cannot answer, the store fails open into the in process counter
 * so a Redis outage never locks out healthy requests while each instance still
 * caps obvious floods.
 */
export class RedisRateLimitStore implements Store {
  private windowMs = 60_000;
  private readonly local = new MemoryFallbackStore();

  constructor(
    private readonly redis: Redis,
    readonly prefix: string,
  ) {}

  init(options: Options): void {
    const windowMs = Number(options.windowMs);
    if (Number.isFinite(windowMs) && windowMs > 0) this.windowMs = windowMs;
    // The fallback reads its rolling window on every call, so setting it here
    // and on each fallback keeps the two in step without a second init.
    this.local.init({ windowMs: this.windowMs } as Options);
  }

  private keyFor(key: string): string {
    return `ratelimit:${this.prefix}:${createHash('sha256').update(String(key)).digest('hex')}`;
  }

  async increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }> {
    const redisKey = this.keyFor(key);
    try {
      const [total, ttl] = (await this.redis.eval(
        INCREMENT_SCRIPT,
        1,
        redisKey,
        String(this.windowMs),
      )) as [number, number];
      if (typeof total !== 'number' || typeof ttl !== 'number') {
        throw new Error('Unexpected rate limit reply');
      }

      const remaining = ttl > 0 ? ttl : this.windowMs;
      return { totalHits: total, resetTime: new Date(Date.now() + remaining) };
    } catch {
      // Fail open: keep counting locally so one instance still caps a flood.
      // Redis may still be connecting on the very first request, so make sure
      // the fallback knows this limiter's window even if init was skipped.
      this.local.init({ windowMs: this.windowMs } as Options);
      // Use the same hashed key as the Redis path. A token or account limiter
      // passes sensitive values here, and the fallback must not keep them in
      // process memory any more than Redis may.
      return this.local.increment(this.keyFor(key));
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.redis.eval(DECREMENT_SCRIPT, 1, this.keyFor(key), String(this.windowMs));
    } catch {
      this.local.decrement(this.keyFor(key));
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await Promise.resolve(this.redis.del(this.keyFor(key)));
    } catch {
      this.local.resetKey(this.keyFor(key));
    }
  }

  async resetAll(): Promise<void> {
    this.local.resetAll();
    try {
      // Clear this limiter's shared counters too, so a reset is not half done.
      // SCAN keeps Redis responsive; this helper is for tests and operations,
      // never the request path.
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `ratelimit:${this.prefix}:*`,
          'COUNT',
          100,
        );
        cursor = next;
        if (keys.length > 0) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch {
      // Fail open: the in process fallback is already clear, and the shared
      // counters expire on their own window.
    }
  }
}

/** How long one rate limit command may wait for a connected Redis. */
const RATE_LIMIT_COMMAND_TIMEOUT_MS = 500;

/**
 * Builds the Redis client used by the rate limiters.
 *
 * Exported so outage regression tests can point it at an unreachable port
 * and prove the store falls back without waiting for a reconnect.
 */
export function createRateLimitRedisClient(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    // Never queue a command while disconnected. A queued command waits for the
    // next reconnect, and the backoff below grows to ten seconds, so the rate
    // limit check would delay the request it is meant to protect. The command
    // fails at once, the store falls back to its in process counter, and the
    // connection keeps retrying in the background.
    enableOfflineQueue: false,
    // A connected socket can still stop answering. Bound that wait as well, so
    // a stalled Redis never holds a request open.
    commandTimeout: RATE_LIMIT_COMMAND_TIMEOUT_MS,
    connectionName: 'f-commerce-rate-limit',
    connectTimeout: 1_000,
    retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
  });
}

let sharedRedis: Redis | null = null;

/**
 * Returns the single multiplexed Redis connection shared by every rate limiter
 * (both general API limiters and team invitation limiters). Created lazily on
 * the first real request so test imports and disabled limiters open no socket.
 */
export function getRateLimitRedisClient(): Redis {
  if (!sharedRedis) {
    sharedRedis = createRateLimitRedisClient(config.REDIS_URL);
    sharedRedis.on('error', (error) => {
      console.error('Redis rate limit connection error:', error.message);
    });
  }
  return sharedRedis;
}

export async function closeRateLimitStore(): Promise<void> {
  const client = sharedRedis;
  sharedRedis = null;
  if (!client) return;
  try {
    await client.quit();
  } catch {
    // When Redis is unreachable and offline queuing is off, quit rejects; drop
    // the handle directly so shutdown and test teardown always settle.
    client.disconnect();
  }
}
