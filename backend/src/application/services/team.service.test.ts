import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAuthRepository } from '../../domain/repositories/auth.repository.js';
import type {
  ITeamRepository,
  NewInvitationData,
  TeamInvitationRecord,
  TeamMemberRecord,
} from '../../domain/repositories/team.repository.js';
import type { Invitation } from '../../domain/entities/invitation.entity.js';
import {
  EmailMismatchError,
  InviteAlreadyAcceptedError,
  InviteAlreadyMemberError,
  InviteAlreadyPendingError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  LastOwnerError,
  SelfChangeNotAllowedError,
  SignInRequiredError,
  TeamMemberNotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import { hashInviteToken } from '../../domain/invitation-token.js';
import type { User } from '../../domain/entities/user.entity.js';
import { TeamService } from './team.service.js';

vi.mock('bcrypt');
vi.mock('../../infrastructure/services/resend-email.service.js', () => ({
  isEmailConfigured: vi.fn(() => true),
}));

const { isEmailConfigured } = await import('../../infrastructure/services/resend-email.service.js');

const BIZ = 'business-1';
const OWNER = 'user-owner';
const INVITEE = 'user-invitee';
const NOW = new Date('2026-03-01T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function uniqueViolation(): Error {
  const error = new Error('duplicate key value violates unique constraint') as Error & {
    code: string;
  };
  error.code = '23505';
  return error;
}

/** The raw token only exists in the returned link. */
function tokenOf(inviteUrl: string): string {
  return inviteUrl.split('/').pop() ?? '';
}

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  const createdAt = new Date(NOW.getTime() - DAY);
  return {
    id: 'invitation-1',
    businessId: BIZ,
    email: 'sam@example.com',
    role: 'STAFF',
    tokenHash: 'stored-hash',
    invitedByUserId: OWNER,
    expiresAt: new Date(NOW.getTime() + 6 * DAY),
    lastSentAt: createdAt,
    emailStatus: 'QUEUED',
    emailAttempts: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function listed(overrides: Partial<Invitation> = {}): TeamInvitationRecord {
  return { ...invitation(overrides), invitedByName: 'Maya Owner' };
}

function member(overrides: Partial<TeamMemberRecord> = {}): TeamMemberRecord {
  return {
    membershipId: 'membership-1',
    userId: INVITEE,
    name: 'Sam Staff',
    email: 'sam@example.com',
    role: 'STAFF',
    joinedAt: new Date(NOW.getTime() - 30 * DAY),
    ...overrides,
  };
}

function user(overrides: Partial<User> = {}): User {
  const createdAt = new Date(NOW.getTime() - 60 * DAY);
  return {
    id: INVITEE,
    email: 'sam@example.com',
    name: 'Sam Staff',
    passwordHash: null,
    oauth: [],
    isActive: true,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  } as User;
}

interface Stubs {
  teamRepository: { [K in keyof ITeamRepository]: ReturnType<typeof vi.fn> };
  authRepository: { [K in keyof IAuthRepository]: ReturnType<typeof vi.fn> };
  emailQueue: { enqueue: ReturnType<typeof vi.fn> };
  tokenIssuer: { issueTokensForUser: ReturnType<typeof vi.fn> };
  service: TeamService;
}

function setup(): Stubs {
  const teamRepository = {
    listMembers: vi.fn(async () => [member()]),
    listInvitations: vi.fn(async () => [listed()]),
    countOwners: vi.fn(async () => 2),
    findMemberById: vi.fn(async () => member()),
    findMemberByEmail: vi.fn(async () => null),
    findInvitationById: vi.fn(async () => listed()),
    findLiveInvitationByEmail: vi.fn(async () => null),
    findInvitationByTokenHash: vi.fn(async () => ({
      invitation: invitation(),
      businessName: 'Maya Threads',
      inviterName: 'Maya Owner',
    })),
    createInvitation: vi.fn(async (data: NewInvitationData) =>
      invitation({ tokenHash: data.tokenHash }),
    ),
    rotateInvitation: vi.fn(async (_businessId: string, _id: string, tokenHash: string) =>
      invitation({ tokenHash }),
    ),
    revokeInvitation: vi.fn(async () => true),
    markEmailSent: vi.fn(async () => true),
    markEmailFailed: vi.fn(async () => true),
    markEmailSkipped: vi.fn(async () => true),
    setEmailAttempts: vi.fn(async () => undefined),
    updateMemberRole: vi.fn(async () => member({ role: 'OWNER' })),
    removeMember: vi.fn(async () => true),
    acceptInvitation: vi.fn(async () => ({
      membershipId: 'membership-1',
      userId: INVITEE,
      businessId: BIZ,
      role: 'STAFF' as const,
    })),
  };

  const authRepository = {
    findUserByEmail: vi.fn(async () => null),
    findUserById: vi.fn(async () => user({ id: OWNER, email: 'maya@example.com' })),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    createBusiness: vi.fn(),
    createBusinessMember: vi.fn(),
    findBusinessMember: vi.fn(),
    findUserBusinesses: vi.fn(async () => []),
    createRefreshToken: vi.fn(),
    findRefreshToken: vi.fn(),
    revokeRefreshToken: vi.fn(),
  };

  const emailQueue = { enqueue: vi.fn(async () => true) };
  const tokenIssuer = {
    issueTokensForUser: vi.fn(async () => ({ accessToken: 'access', refreshToken: 'refresh' })),
  };

  const service = new TeamService(
    teamRepository as unknown as ITeamRepository,
    authRepository as unknown as IAuthRepository,
    emailQueue,
    tokenIssuer,
    'https://shop.example.com/',
    () => NOW,
  );

  return { teamRepository, authRepository, emailQueue, tokenIssuer, service };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isEmailConfigured).mockReturnValue(true);
});

describe('listing the team', () => {
  it('returns active members with ISO dates and marks a passed expiry as expired', async () => {
    const { service, teamRepository } = setup();
    teamRepository.listInvitations.mockResolvedValueOnce([
      listed(),
      listed({ id: 'invitation-2', expiresAt: new Date(NOW.getTime() - 1000) }),
    ]);

    const result = await service.list(BIZ);

    expect(result.members).toEqual([
      {
        id: 'membership-1',
        userId: INVITEE,
        name: 'Sam Staff',
        email: 'sam@example.com',
        role: 'STAFF',
        joinedAt: member().joinedAt.toISOString(),
      },
    ]);
    expect(result.invitations.map((row) => row.status)).toEqual(['PENDING', 'EXPIRED']);
    expect(result.invitations[0]).toMatchObject({
      invitedByName: 'Maya Owner',
      sentAt: null,
      emailStatus: 'QUEUED',
      emailError: null,
    });
  });

  it('shows an email reason only when the send failed', async () => {
    const { service, teamRepository } = setup();
    teamRepository.listInvitations.mockResolvedValueOnce([
      listed({ id: 'a', emailStatus: 'FAILED', lastEmailError: 'PROVIDER_REJECTED' }),
      listed({ id: 'b', emailStatus: 'SENT', lastEmailError: 'stale note' }),
    ]);

    const result = await service.list(BIZ);

    expect(result.invitations.map((row) => row.emailError)).toEqual(['PROVIDER_REJECTED', null]);
  });
});

describe('creating an invitation', () => {
  it('stores a hashed token, returns the link once, and queues the email', async () => {
    const { service, teamRepository, emailQueue } = setup();

    const result = await service.invite(BIZ, OWNER, { email: '  SAM@Example.com ' });

    expect(result.inviteUrl).toMatch(/^https:\/\/shop\.example\.com\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(result.inviteUrl);
    expect(result.emailStatus).toBe('QUEUED');
    expect(result.emailError).toBeNull();

    const created = teamRepository.createInvitation.mock.calls[0]?.[0];
    expect(created).toMatchObject({
      businessId: BIZ,
      email: 'sam@example.com',
      role: 'STAFF',
      invitedByUserId: OWNER,
      tokenHash: hashInviteToken(token),
    });
    expect(created.tokenHash).not.toBe(token);
    expect(created.expiresAt.getTime()).toBe(NOW.getTime() + 7 * DAY);
    expect(emailQueue.enqueue).toHaveBeenCalledWith({
      invitationId: 'invitation-1',
      tokenHash: hashInviteToken(token),
      token,
    });
  });

  it('refuses an address that already belongs to a member', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findMemberByEmail.mockResolvedValueOnce(member());

    await expect(service.invite(BIZ, OWNER, { email: 'sam@example.com' })).rejects.toBeInstanceOf(
      InviteAlreadyMemberError,
    );
    expect(teamRepository.createInvitation).not.toHaveBeenCalled();
  });

  it('refuses a second live invitation and names the first', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findLiveInvitationByEmail.mockResolvedValueOnce(invitation());

    const failure = await service
      .invite(BIZ, OWNER, { email: 'sam@example.com' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InviteAlreadyPendingError);
    expect((failure as InviteAlreadyPendingError).invitationId).toBe('invitation-1');
  });

  it('cancels an expired invitation before creating a new one', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findLiveInvitationByEmail.mockResolvedValueOnce(
      invitation({ expiresAt: new Date(NOW.getTime() - DAY) }),
    );

    await service.invite(BIZ, OWNER, { email: 'sam@example.com' });

    expect(teamRepository.revokeInvitation).toHaveBeenCalledWith(BIZ, 'invitation-1', {
      userId: OWNER,
    });
    expect(teamRepository.createInvitation).toHaveBeenCalled();
  });

  it('turns a race on the live index into a pending conflict', async () => {
    const { service, teamRepository } = setup();
    teamRepository.createInvitation.mockRejectedValueOnce(uniqueViolation());

    await expect(service.invite(BIZ, OWNER, { email: 'sam@example.com' })).rejects.toBeInstanceOf(
      InviteAlreadyPendingError,
    );
  });

  it('keeps the invitation and records a skipped email when no provider is configured', async () => {
    const { service, teamRepository } = setup();
    vi.mocked(isEmailConfigured).mockReturnValue(false);

    const result = await service.invite(BIZ, OWNER, { email: 'sam@example.com' });

    expect(result.emailStatus).toBe('SKIPPED');
    expect(result.emailError).toBeNull();
    expect(teamRepository.markEmailSkipped).toHaveBeenCalledWith(
      'invitation-1',
      hashInviteToken(tokenOf(result.inviteUrl)),
    );
  });

  it('keeps the invitation and marks the email failed when the queue is unavailable', async () => {
    const { service, teamRepository, emailQueue } = setup();
    emailQueue.enqueue.mockResolvedValueOnce(false);

    const result = await service.invite(BIZ, OWNER, { email: 'sam@example.com' });

    expect(result.emailStatus).toBe('FAILED');
    expect(result.emailError).toBe('QUEUE_UNAVAILABLE');
    expect(teamRepository.markEmailFailed).toHaveBeenCalledWith(
      'invitation-1',
      hashInviteToken(tokenOf(result.inviteUrl)),
      'QUEUE_UNAVAILABLE',
    );
  });
});

describe('resending and cancelling', () => {
  it('rotates the token, moves the expiry out, and sends the new link', async () => {
    const { service, teamRepository, emailQueue } = setup();

    const result = await service.resend(BIZ, OWNER, 'invitation-1');

    const token = tokenOf(result.inviteUrl);
    const rotate = teamRepository.rotateInvitation.mock.calls[0];
    expect(rotate?.[0]).toBe(BIZ);
    expect(rotate?.[1]).toBe('invitation-1');
    expect(rotate?.[2]).toBe(hashInviteToken(token));
    expect((rotate?.[3] as Date).getTime()).toBe(NOW.getTime() + 7 * DAY);
    expect(emailQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ token, tokenHash: hashInviteToken(token) }),
    );
  });

  it('refuses to resend an accepted or revoked invitation', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findInvitationById.mockResolvedValueOnce(
      listed({ acceptedAt: new Date(NOW.getTime() - DAY) }),
    );

    await expect(service.resend(BIZ, OWNER, 'invitation-1')).rejects.toBeInstanceOf(
      InviteNotFoundError,
    );
  });

  it('revokes an invitation and reports a missing one', async () => {
    const { service, teamRepository } = setup();

    await service.cancel(BIZ, OWNER, 'invitation-1');
    expect(teamRepository.revokeInvitation).toHaveBeenCalledWith(BIZ, 'invitation-1', {
      userId: OWNER,
    });

    teamRepository.revokeInvitation.mockResolvedValueOnce(false);
    await expect(service.cancel(BIZ, OWNER, 'missing')).rejects.toBeInstanceOf(InviteNotFoundError);
  });
});

describe('roles and removal', () => {
  it('promotes a member and audits the change', async () => {
    const { service, teamRepository } = setup();

    const updated = await service.changeRole(BIZ, OWNER, 'membership-1', 'OWNER');

    expect(updated.role).toBe('OWNER');
    expect(teamRepository.updateMemberRole).toHaveBeenCalledWith(BIZ, 'membership-1', 'OWNER', {
      userId: OWNER,
    });
  });

  it('refuses to change your own role', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findMemberById.mockResolvedValueOnce(member({ userId: OWNER }));

    await expect(service.changeRole(BIZ, OWNER, 'membership-1', 'STAFF')).rejects.toBeInstanceOf(
      SelfChangeNotAllowedError,
    );
  });

  it('refuses to demote the last owner', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findMemberById.mockResolvedValueOnce(member({ role: 'OWNER' }));
    teamRepository.countOwners.mockResolvedValueOnce(1);

    await expect(service.changeRole(BIZ, OWNER, 'membership-1', 'STAFF')).rejects.toBeInstanceOf(
      LastOwnerError,
    );
    expect(teamRepository.updateMemberRole).not.toHaveBeenCalled();
  });

  it('treats a role that already matches as done without writing', async () => {
    const { service, teamRepository } = setup();

    const unchanged = await service.changeRole(BIZ, OWNER, 'membership-1', 'STAFF');

    expect(unchanged.role).toBe('STAFF');
    expect(teamRepository.updateMemberRole).not.toHaveBeenCalled();
  });

  it('removes a member and refuses the last owner or yourself', async () => {
    const { service, teamRepository } = setup();

    await service.removeMember(BIZ, OWNER, 'membership-1');
    expect(teamRepository.removeMember).toHaveBeenCalledWith(BIZ, 'membership-1', {
      userId: OWNER,
    });

    teamRepository.findMemberById.mockResolvedValueOnce(member({ userId: OWNER }));
    await expect(service.removeMember(BIZ, OWNER, 'membership-1')).rejects.toBeInstanceOf(
      SelfChangeNotAllowedError,
    );

    teamRepository.findMemberById.mockResolvedValueOnce(member({ role: 'OWNER' }));
    teamRepository.countOwners.mockResolvedValueOnce(1);
    await expect(service.removeMember(BIZ, OWNER, 'membership-1')).rejects.toBeInstanceOf(
      LastOwnerError,
    );
  });

  it('reports an unknown member', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findMemberById.mockResolvedValueOnce(null);

    await expect(service.removeMember(BIZ, OWNER, 'missing')).rejects.toBeInstanceOf(
      TeamMemberNotFoundError,
    );
  });
});

describe('previewing an invitation', () => {
  it('describes the business, the inviter, and what the invitee should do next', async () => {
    const { service, authRepository, teamRepository } = setup();
    authRepository.findUserByEmail.mockResolvedValueOnce(user({ passwordHash: 'hashed' }));
    teamRepository.findMemberByEmail.mockResolvedValueOnce(null);

    const preview = await service.preview('raw-token');

    expect(teamRepository.findInvitationByTokenHash).toHaveBeenCalledWith(
      hashInviteToken('raw-token'),
    );
    expect(preview).toEqual({
      businessName: 'Maya Threads',
      inviterName: 'Maya Owner',
      email: 'sam@example.com',
      role: 'STAFF',
      expiresAt: invitation().expiresAt.toISOString(),
      accountExists: true,
      hasPassword: true,
      alreadyMember: false,
    });
  });

  it('flags an address that is already a member', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findMemberByEmail.mockResolvedValueOnce(member());

    const preview = await service.preview('raw-token');

    expect(preview.alreadyMember).toBe(true);
  });

  it.each([
    ['unknown', { revokedAt: undefined, acceptedAt: undefined }, InviteNotFoundError],
    ['revoked', { revokedAt: new Date(NOW.getTime() - DAY) }, InviteRevokedError],
    ['accepted', { acceptedAt: new Date(NOW.getTime() - DAY) }, InviteAlreadyAcceptedError],
    ['expired', { expiresAt: new Date(NOW.getTime() - 1) }, InviteExpiredError],
  ])('explains a %s invitation', async (_label, overrides, expected) => {
    const { service, teamRepository } = setup();
    if (_label === 'unknown') {
      teamRepository.findInvitationByTokenHash.mockResolvedValueOnce(null);
    } else {
      teamRepository.findInvitationByTokenHash.mockResolvedValueOnce({
        invitation: invitation(overrides),
        businessName: 'Maya Threads',
        inviterName: 'Maya Owner',
      });
    }

    await expect(service.preview('raw-token')).rejects.toBeInstanceOf(expected);
  });
});

describe('accepting an invitation', () => {
  it('creates the account for an anonymous invitee and signs them into the business', async () => {
    const bcrypt = await import('bcrypt');
    vi.mocked(bcrypt.genSalt).mockResolvedValueOnce('salt' as never);
    vi.mocked(bcrypt.hash).mockResolvedValueOnce('hashed-pass' as never);
    const { service, teamRepository, tokenIssuer } = setup();

    const result = await service.accept(
      'raw-token',
      { name: '  Sam Staff ', password: 'correct horse' },
      undefined,
    );

    expect(teamRepository.acceptInvitation).toHaveBeenCalledWith({
      invitationId: 'invitation-1',
      email: 'sam@example.com',
      role: 'STAFF',
      name: 'Sam Staff',
      passwordHash: 'hashed-pass',
      existingUserId: undefined,
      accountExists: false,
    });
    expect(tokenIssuer.issueTokensForUser).toHaveBeenCalledWith(INVITEE, BIZ);
    expect(result).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      businessId: BIZ,
    });
  });

  it('falls back to the address local part when no name is given', async () => {
    const { service, teamRepository } = setup();

    await service.accept('raw-token', { password: 'long enough' }, undefined);

    expect(teamRepository.acceptInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sam' }),
    );
  });

  it('requires a password to create an account', async () => {
    const { service } = setup();

    await expect(service.accept('raw-token', {}, undefined)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('asks an account that already has a password to sign in first', async () => {
    const { service, authRepository } = setup();
    authRepository.findUserByEmail.mockResolvedValueOnce(user({ passwordHash: 'hashed' }));

    await expect(service.accept('raw-token', {}, undefined)).rejects.toBeInstanceOf(
      SignInRequiredError,
    );
  });

  it('lets a passwordless account set its first password', async () => {
    const { service, authRepository, teamRepository } = setup();
    authRepository.findUserByEmail.mockResolvedValueOnce(user({ passwordHash: undefined }));

    await service.accept('raw-token', { password: 'first password' }, undefined);

    expect(teamRepository.acceptInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ existingUserId: INVITEE, accountExists: true }),
    );
  });

  it('requires the signed in caller to own the invited address', async () => {
    const { service, authRepository } = setup();
    authRepository.findUserById.mockResolvedValueOnce(
      user({ id: INVITEE, email: 'someone-else@example.com' }),
    );

    await expect(service.accept('raw-token', {}, INVITEE)).rejects.toBeInstanceOf(
      EmailMismatchError,
    );
  });

  it('accepts for the signed in owner of the invited address', async () => {
    const { service, authRepository, teamRepository } = setup();
    authRepository.findUserById.mockResolvedValueOnce(user({ id: INVITEE }));

    await service.accept('raw-token', {}, INVITEE);

    expect(teamRepository.acceptInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ existingUserId: INVITEE, passwordHash: undefined }),
    );
  });

  it('refuses to accept twice because the address is already a member', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findMemberByEmail.mockResolvedValueOnce(member());

    await expect(
      service.accept('raw-token', { password: 'long enough' }, undefined),
    ).rejects.toBeInstanceOf(InviteAlreadyMemberError);
  });

  it('turns a membership race into the same conflict', async () => {
    const { service, teamRepository } = setup();
    teamRepository.acceptInvitation.mockRejectedValueOnce(uniqueViolation());

    await expect(
      service.accept('raw-token', { password: 'long enough' }, undefined),
    ).rejects.toBeInstanceOf(InviteAlreadyMemberError);
  });

  it('refuses an expired invitation', async () => {
    const { service, teamRepository } = setup();
    teamRepository.findInvitationByTokenHash.mockResolvedValueOnce({
      invitation: invitation({ expiresAt: new Date(NOW.getTime() - 1) }),
      businessName: 'Maya Threads',
      inviterName: 'Maya Owner',
    });

    await expect(
      service.accept('raw-token', { password: 'long enough' }, undefined),
    ).rejects.toBeInstanceOf(InviteExpiredError);
  });
});
