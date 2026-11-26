import type { Redis } from 'ioredis';

export const GENERAL_RATE_LIMIT_PREFIXES = [
  'ratelimit:global:*',
  'ratelimit:login-ip:*',
  'ratelimit:login-account:*',
  'ratelimit:register:*',
  'ratelimit:refresh:*',
  'ratelimit:upload:*',
] as const;

/**
 * Removes all keys created by the general rate limiters across test runs.
 */
export async function clearGeneralRateLimitKeys(redis: Redis): Promise<void> {
  for (const pattern of GENERAL_RATE_LIMIT_PREFIXES) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}
