import { describe, expect, it } from 'vitest';
import {
  INVITE_TTL_MS,
  expiryFromNow,
  generateInviteToken,
  hashesMatch,
  hashInviteToken,
} from './invitation-token.js';

describe('invitation tokens', () => {
  it('generates 32 random bytes, url safe and unique', () => {
    const first = generateInviteToken();
    const second = generateInviteToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it('stores only a SHA256 hash of the token', () => {
    const token = 'raw-token';

    expect(hashInviteToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
    expect(hashInviteToken(token)).not.toContain(token);
    expect(hashInviteToken('another')).not.toBe(hashInviteToken(token));
  });

  it('compares hashes without throwing on different lengths', () => {
    const hash = hashInviteToken('raw-token');

    expect(hashesMatch(hash, hash)).toBe(true);
    expect(hashesMatch(hash, 'short')).toBe(false);
  });

  it('expires an invitation seven days out', () => {
    const now = new Date('2026-03-01T09:00:00.000Z');

    expect(expiryFromNow(now).getTime() - now.getTime()).toBe(INVITE_TTL_MS);
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
