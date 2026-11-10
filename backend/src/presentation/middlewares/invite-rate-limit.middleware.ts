import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Options, Store } from 'express-rate-limit';
import type { Request, Response, RequestHandler } from 'express';
import { config } from '../../infrastructure/config.js';
import { MemoryFallbackStore } from './memory-fallback-store.js';

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
      // Use the same hashed key as the Redis path. A token limiter passes a raw
      // bearer secret here, and the fallback must not keep it in process memory
      // any more than Redis may.
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

/**
 * The check runs per request, but the config object is frozen at import time, so
 * tests switch the flag off by loading this module with the config already true
 * and reset the modules between cases.
 */
function rateLimitsDisabled(): boolean {
  return config.RATE_LIMIT_DISABLED && config.NODE_ENV !== 'production';
}

function sendTooMany(_req: Request, res: Response): void {
  // A 429 on an invite route can be reached with the raw token in the path, so
  // it carries the same link headers as the successful responses.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
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
      // Built once here and cached above, over a shared Redis store, so the
      // "created in a request handler" warning cannot apply. Silence only that
      // check and leave every other validation on.
      validate: { creationStack: false },
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

// requireAuth runs before every route that uses this limiter, so req.user is
// always set; the fallback only satisfies the optional type.
const ownerKey = (req: Request): string => `owner:${req.user?.userId ?? 'anonymous'}`;
/** The address as express-rate-limit counts it, normalised for IPv6. */
const ipKey = (req: Request): string => `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
/**
 * The invite token when the route carries one, so a flood against a single
 * link is capped even if the caller rotates its address. The store hashes
 * every key before it reaches Redis, so the raw token is never stored.
 */
const tokenKey = (req: Request): string => {
  const token = req.params.token;
  return typeof token === 'string' && token !== '' ? `token:${token}` : ipKey(req);
};

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

/**
 * The same accept cap per invite token. A per address limit alone can be
 * rotated by changing `X-Forwarded-For` on a host that passes the header
 * through; this layer keeps one link's attempts capped no matter the address.
 */
export const inviteAcceptTokenRateLimiter = teamLimiter('team-accept-token', {
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: tokenKey,
});

/** The preview cap per invite token, for the same reason as accept. */
export const invitePreviewTokenRateLimiter = teamLimiter('team-preview-token', {
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: tokenKey,
});
