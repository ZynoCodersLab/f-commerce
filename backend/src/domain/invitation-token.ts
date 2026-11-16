import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, the only secret the invite link carries (AC-20). */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The stored form of a token. A plain SHA256 is enough here: the token is 256
 * bits of randomness, so there is nothing to guess and no need for a slow hash
 * that would also stop the worker from looking a job up by hash.
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant time compare of two hex hashes, used before a job touches an invite. */
export function hashesMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The one place an invite link is built, so every sender uses the same shape. */
export function buildInviteUrl(appOrigin: string, token: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/invite/${token}`;
}

/** Invitations live seven days from creation or from the last resend (AC-1, AC-12). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function expiryFromNow(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_MS);
}
