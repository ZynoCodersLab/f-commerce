import type { Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Options } from 'express-rate-limit';

import { config } from '../../infrastructure/config.js';
import { RedisRateLimitStore, getRateLimitRedisClient } from './redis-rate-limit-store.js';

/**
 * End-to-end suites create many accounts and sign-ins from one IP. CI sets
 * this flag so those tests exercise application behaviour instead of the
 * limiter; production ignores it even if the variable is set.
 */
function rateLimitsDisabled(): boolean {
  return config.RATE_LIMIT_DISABLED && config.NODE_ENV !== 'production';
}

/** Every limiter returns the API's JSON error shape instead of Express's default text. */
function sendRateLimited(_request: Request, response: Response): void {
  response.status(429).json({
    error: 'RATE_LIMITED',
    message: 'Too many requests. Please try again later.',
  });
}

/**
 * Common header and response options. `standardHeaders: 'draft-8'` exposes the
 * `RateLimit` and `Retry-After` headers; legacy `X-RateLimit-*` headers are off
 * so clients only have one contract.
 */
const baseOptions = {
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  handler: sendRateLimited,
};

/**
 * Build a general API limiter backed by the shared Redis store (with an in
 * process fallback when Redis cannot answer). Built lazily on the first real
 * request so loading this module or probing `/health` never opens a socket.
 */
function createGeneralLimiter(
  name: string,
  options: Partial<Options> & { windowMs: number; limit: number },
  shouldSkip?: (request: Request) => boolean,
): RequestHandler {
  let limiter: RequestHandler | null = null;

  const build = (): RequestHandler => {
    limiter ??= rateLimit({
      ...baseOptions,
      store: new RedisRateLimitStore(getRateLimitRedisClient(), name),
      // Built once and cached above over a shared Redis store, so the
      // "created in a request handler" warning cannot apply.
      validate: { creationStack: false },
      ...options,
    });
    return limiter;
  };

  return (request, response, next) => {
    if (rateLimitsDisabled() || shouldSkip?.(request)) {
      next();
      return;
    }
    build()(request, response, next);
  };
}

/**
 * Per-IP backstop for the whole API. `/health` is skipped before touching the
 * store so platform probes never open or depend on Redis. The limit is per
 * client IP, so the host's proxy must set or normalize `X-Forwarded-For`: the
 * backend trusts exactly one proxy hop (`trust proxy = 1`).
 */
export const globalRateLimiter = createGeneralLimiter(
  'global',
  {
    windowMs: 60_000,
    limit: 100,
  },
  (request) => request.path === '/health',
);

/**
 * Two login limiters: one per IP and one per account. The IP bucket blocks a
 * single client spraying many accounts; the account bucket blocks a distributed
 * attack on one account. Successful sign-ins do not consume either allowance.
 */
export const loginIpRateLimiter = createGeneralLimiter('login-ip', {
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
});

function loginAccountKey(request: Request): string {
  const email = (request.body as { email?: unknown } | undefined)?.email;
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (normalized === '') {
    return `login:ip:${ipKeyGenerator(request.ip ?? '')}`;
  }

  return `login:${normalized}`;
}

export const loginAccountRateLimiter = createGeneralLimiter('login-account', {
  windowMs: 15 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: loginAccountKey,
});

export const registerRateLimiter = createGeneralLimiter('register', {
  windowMs: 60 * 60_000,
  limit: 5,
});

export const refreshRateLimiter = createGeneralLimiter('refresh', {
  windowMs: 60_000,
  limit: 60,
});

/**
 * Uploads buffer whole files in memory before Cloudinary sees them, so this
 * limiter runs before multer on the image routes. Authenticated routes key on
 * the verified user instead of a header a client can spoof.
 */
export const uploadRateLimiter = createGeneralLimiter('upload', {
  windowMs: 60_000,
  limit: 10,
  keyGenerator: (request) =>
    request.user?.userId
      ? `upload:${request.user.userId}`
      : `upload:ip:${ipKeyGenerator(request.ip ?? '')}`,
});
