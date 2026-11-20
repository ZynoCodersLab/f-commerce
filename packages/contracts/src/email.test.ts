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

  it('is shared across auth and team schemas', () => {
    expect(TeamEmailSchema).toBe(EmailSchema);
    expect(RegisterSchema.shape.email).toBe(EmailSchema);
    expect(LoginSchema.shape.email).toBe(EmailSchema);
    expect(OAuthLoginSchema.shape.email).toBe(EmailSchema);
    expect(InviteCreateSchema.shape.email).toBe(EmailSchema);
  });
});
