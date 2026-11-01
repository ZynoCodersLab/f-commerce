import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Options, Store } from 'express-rate-limit';
import type { Request, Response, RequestHandler } from 'express';
import { config } from '../../infrastructure/config.js';
import { MemoryFallbackStore } from './memory-fallback-store.js';

/**
 * A counter shared by every API instance, because a limit that only counts
 * inside one process resets on every deploy and triples on three instances.
 *
 * The spec requires the invitation limiters to fail open: when Redis cannot
 * answer, a request is allowed and only the in process counter still applies.
 * A shared limit is a protection, never a reason to refuse a legitimate
 * owner who is trying to invite a colleague.
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
      const results = await this.redis
        .multi()
        .incr(redisKey)
        .pexpire(redisKey, this.windowMs, 'NX')
        .pttl(redisKey)
        .exec();

      const [[incrError, total], , [ttlError, ttl]] = results ?? [];
      if (incrError || ttlError || typeof total !== 'number') throw incrError ?? ttlError;

      const remaining = typeof ttl === 'number' && ttl > 0 ? ttl : this.windowMs;
      return { totalHits: total, resetTime: new Date(Date.now() + remaining) };
    } catch {
      // Fail open: keep counting locally so one instance still caps a flood.
      // Redis may still be connecting on the very first request, so make sure
      // the fallback knows this limiter's window even if init was skipped.
      this.local.init({ windowMs: this.windowMs } as Options);
      return this.local.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await Promise.resolve(this.redis.decr(this.keyFor(key)));
    } catch {
      this.local.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await Promise.resolve(this.redis.del(this.keyFor(key)));
    } catch {
      this.local.resetKey(key);
    }
  }

  async resetAll(): Promise<void> {
    this.local.resetAll();
  }
}

let sharedRedis: Redis | null = null;

function redisClient(): Redis {
  if (!sharedRedis) {
    sharedRedis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      connectionName: 'f-commerce-rate-limit',
      // Give up on the first connect failure so the request falls through to
      // the in process counter instead of waiting in an offline queue. A later
      // request retries the connection on its own.
      connectTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
    });
    sharedRedis.on('error', (error) => {
      console.error('Redis rate limit connection error:', error.message);
    });
  }
  return sharedRedis;
}

export function closeRateLimitStore(): Promise<void> {
  const client = sharedRedis;
  sharedRedis = null;
  return client ? client.quit().then(() => undefined) : Promise.resolve();
}

/** The flag is read at call time so tests can switch the limiters off. */
function rateLimitsDisabled(): boolean {
  return config.RATE_LIMIT_DISABLED && config.NODE_ENV !== 'production';
}

function sendTooMany(_req: Request, res: Response): void {
  res.status(429).json({
    error: 'RATE_LIMITED',
    message: 'Too many requests. Please try again later.',
  });
}

function teamLimiter(
  name: string,
  options: Partial<Options> & { windowMs: number; limit: number },
): RequestHandler {
  let limiter: RequestHandler | null = null;

  // Built on the first real request instead of at import time. Validating the
  // options here keeps a bad configuration loud, and it means a test process
  // never opens a Redis connection just because the module was loaded.
  const build = (): RequestHandler => {
    limiter ??= rateLimit({
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: sendTooMany,
      // One store per limiter, because each limiter has its own window and its
      // own counters. They share the Redis connection underneath.
      store: new RedisRateLimitStore(redisClient(), name),
      ...options,
    });
    return limiter;
  };

  // The disabled flag is read per request, like the other limiters, so a
  // process that starts with the limiters on can still turn them off.
  return (req, res, next) => {
    if (rateLimitsDisabled()) return next();
    build()(req, res, next);
  };
}

const ownerKey = (req: Request): string => `owner:${req.user?.userId ?? 'anonymous'}`;
/** The address as express-rate-limit counts it, normalised for IPv6. */
const ipKey = (req: Request): string => `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;

/** Ten invitations or resends an hour per owner (AC-24). */
export const inviteWriteRateLimiter = teamLimiter('team-write', {
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: ownerKey,
});

/** Five accept attempts per quarter hour per address; token guesses are expensive. */
export const inviteAcceptRateLimiter = teamLimiter('team-accept', {
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: ipKey,
});

/** Thirty previews a minute per address, enough for a person and a refresh. */
export const invitePreviewRateLimiter = teamLimiter('team-preview', {
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: ipKey,
});
