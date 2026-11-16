import { describe, expect, it } from 'vitest';
import {
  InviteAcceptSchema,
  InviteCreateSchema,
  MemberRoleUpdateSchema,
  TeamMemberSchema,
} from './index.js';

describe('invite create contract', () => {
  // covers AC-18: an email is trimmed and lowercased before it is stored
  it('trims and lowercases the email', () => {
    const parsed = InviteCreateSchema.parse({ email: '  Staff@Example.COM  ' });

    expect(parsed.email).toBe('staff@example.com');
  });

  // covers AC-1: a new invite defaults to the staff role
  it('defaults the role to staff', () => {
    expect(InviteCreateSchema.parse({ email: 'a@example.com' }).role).toBe('STAFF');
  });

  // covers AC-1: an invite can only grant the staff role
  it('rejects any role other than staff', () => {
    expect(InviteCreateSchema.safeParse({ email: 'a@example.com', role: 'OWNER' }).success).toBe(
      false,
    );
    expect(InviteCreateSchema.parse({ email: 'a@example.com', role: 'STAFF' }).role).toBe('STAFF');
  });

  // covers AC-1: an invalid address is rejected
  it('rejects an invalid email', () => {
    expect(InviteCreateSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});

describe('invite accept contract', () => {
  // covers AC-7: a new account needs a password of at least eight characters
  it('rejects a short password', () => {
    expect(InviteAcceptSchema.safeParse({ password: 'short' }).success).toBe(false);
  });

  // covers AC-8: an existing account may accept with an empty body
  it('accepts an empty body', () => {
    expect(InviteAcceptSchema.parse({}).password).toBeUndefined();
  });
});

describe('member role update contract', () => {
  it('allows only the two roles', () => {
    expect(MemberRoleUpdateSchema.safeParse({ role: 'OWNER' }).success).toBe(true);
    expect(MemberRoleUpdateSchema.safeParse({ role: 'ADMIN' }).success).toBe(false);
  });
});

describe('team response contract', () => {
  const member = {
    id: 'member-1',
    userId: 'user-1',
    name: 'Sam Staff',
    email: 'sam@example.com',
    role: 'STAFF',
    joinedAt: '2026-01-05T09:00:00.000Z',
  };

  it('accepts a timestamp joined date', () => {
    expect(TeamMemberSchema.safeParse(member).success).toBe(true);
  });

  it('rejects a joined date that is not a timestamp', () => {
    expect(TeamMemberSchema.safeParse({ ...member, joinedAt: 'not-a-date' }).success).toBe(false);
  });
});
