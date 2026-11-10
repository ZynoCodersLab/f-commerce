import { describe, expect, it } from 'vitest';
import { LoginSchema, OAuthLoginSchema, RegisterSchema } from './index.js';

// Covers AC-18: every path that accepts an email trims and lowercases it before
// the value reaches the database.

const PADDED = '  Test@Example.COM  ';

describe('auth email normalization', () => {
  it('normalizes a registration email', () => {
    const parsed = RegisterSchema.parse({
      email: PADDED,
      password: 'long-enough',
      name: 'Test User',
      businessName: 'Test Biz',
    });

    expect(parsed.email).toBe('test@example.com');
  });

  it('normalizes a login email', () => {
    expect(LoginSchema.parse({ email: PADDED, password: 'pass' }).email).toBe('test@example.com');
  });

  it('normalizes an oauth email', () => {
    const parsed = OAuthLoginSchema.parse({
      email: PADDED,
      name: 'Test User',
      providerId: 'provider-1',
    });

    expect(parsed.email).toBe('test@example.com');
  });

  it('still rejects an invalid address after trimming', () => {
    expect(LoginSchema.safeParse({ email: '  not-an-email  ', password: 'pass' }).success).toBe(
      false,
    );
  });
});
