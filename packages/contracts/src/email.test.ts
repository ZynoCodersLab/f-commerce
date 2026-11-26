import { describe, expect, it } from 'vitest';
import {
  EmailSchema,
  InviteCreateSchema,
  LoginSchema,
  OAuthLoginSchema,
  RegisterSchema,
  TeamEmailSchema,
} from './index.js';

describe('EmailSchema', () => {
  it('trims and lowercases a valid address', () => {
    expect(EmailSchema.parse('  Owner@Example.COM  ')).toBe('owner@example.com');
  });

  it('rejects an invalid address and addresses longer than 254 characters', () => {
    expect(EmailSchema.safeParse('  not-an-email  ').success).toBe(false);

    const tooLong = `${'a'.repeat(244)}@example.com`;
    expect(tooLong.length).toBe(256);
    expect(EmailSchema.safeParse(tooLong).success).toBe(false);
  });

  it('accepts an address at the exact 254 character limit and rejects 255 characters', () => {
    const domain = '@example.com';
    const maxValid = `${'a'.repeat(254 - domain.length)}${domain}`;
    const oneTooLong = `${'a'.repeat(255 - domain.length)}${domain}`;

    expect(maxValid.length).toBe(254);
    expect(EmailSchema.parse(maxValid)).toBe(maxValid);
    expect(oneTooLong.length).toBe(255);
    expect(EmailSchema.safeParse(oneTooLong).success).toBe(false);
  });

  it('rejects empty and whitespace only strings with a clear message', () => {
    const empty = EmailSchema.safeParse('');
    const spaces = EmailSchema.safeParse('   ');

    expect(empty.success).toBe(false);
    expect(spaces.success).toBe(false);
    if (!spaces.success) {
      expect(spaces.error.issues[0]?.message).toBe('Enter a valid email address');
    }
  });

  it('is shared across auth and team schemas', () => {
    expect(TeamEmailSchema).toBe(EmailSchema);
    expect(RegisterSchema.shape.email).toBe(EmailSchema);
    expect(LoginSchema.shape.email).toBe(EmailSchema);
    expect(OAuthLoginSchema.shape.email).toBe(EmailSchema);
    expect(InviteCreateSchema.shape.email).toBe(EmailSchema);
  });

  it('normalizes email casing and whitespace when parsing auth and invite payloads', () => {
    const raw = '  Staff.Member@Example.COM  ';
    const expected = 'staff.member@example.com';

    expect(
      RegisterSchema.parse({
        email: raw,
        password: 'password123',
        name: 'Sam',
        businessName: 'Demo Shop',
      }).email,
    ).toBe(expected);
    expect(LoginSchema.parse({ email: raw, password: 'secret' }).email).toBe(expected);
    expect(OAuthLoginSchema.parse({ email: raw, name: 'Sam', providerId: 'google-1' }).email).toBe(
      expected,
    );
    expect(InviteCreateSchema.parse({ email: raw }).email).toBe(expected);
  });
});
