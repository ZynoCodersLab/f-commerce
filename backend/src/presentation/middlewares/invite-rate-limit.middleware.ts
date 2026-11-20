import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Options } from 'express-rate-limit';
import type { Request, Response, RequestHandler } from 'express';
import { config } from '../../infrastructure/config.js';
import {
  RedisRateLimitStore,
  closeRateLimitStore,
  createRateLimitRedisClient,
  getRateLimitRedisClient,
} from './redis-rate-limit-store.js';

export { RedisRateLimitStore, closeRateLimitStore, createRateLimitRedisClient };

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
      store: new RedisRateLimitStore(getRateLimitRedisClient(), name),
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
/** The address as express-rate-limit counts it, normalized for IPv6. */
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
