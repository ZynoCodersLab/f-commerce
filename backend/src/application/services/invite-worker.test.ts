import { describe, expect, it, vi } from 'vitest';
import { processInviteEmailJob } from './invite-worker.js';
import type { InviteWorkerDeps } from './invite-worker.js';
import type { ITeamRepository } from '../../domain/repositories/team.repository.js';
import type { IAuthRepository } from '../../domain/repositories/auth.repository.js';
import type { Invitation } from '../../domain/entities/invitation.entity.js';
import type { User } from '../../domain/entities/user.entity.js';
import { hashInviteToken } from '../../domain/invitation-token.js';

const NOW = new Date('2026-03-01T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'raw-invite-token';
const TOKEN_HASH = hashInviteToken(TOKEN);

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  const createdAt = new Date(NOW.getTime() - DAY);
  return {
    id: 'invitation-1',
    businessId: 'business-1',
    email: 'sam@example.com',
    role: 'STAFF',
    tokenHash: TOKEN_HASH,
    invitedByUserId: 'user-owner',
    expiresAt: new Date(NOW.getTime() + 6 * DAY),
    lastSentAt: createdAt,
    emailStatus: 'QUEUED',
    emailAttempts: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function setup(
  overrides: { invitation?: Invitation | null; sendOk?: boolean; sendError?: string } = {},
) {
  const teamRepository = {
    findInvitationByTokenHash: vi.fn(async () => {
      const row = overrides.invitation === undefined ? invitation() : overrides.invitation;
      return row
        ? { invitation: row, businessName: 'Maya Threads', inviterName: 'Maya Owner' }
        : null;
    }),
    markEmailSent: vi.fn(async () => true),
    markEmailFailed: vi.fn(async () => true),
    setEmailAttempts: vi.fn(async () => undefined),
  };
  const authRepository = {
    findUserById: vi.fn(
      async () =>
        ({
          id: 'user-owner',
          email: 'maya@example.com',
          name: 'Maya Owner',
        }) as unknown as User,
    ),
  };
  const send = vi.fn(async () =>
    overrides.sendOk === false
      ? { ok: false as const, errorCode: overrides.sendError ?? 'EMAIL_SEND_FAILED' }
      : { ok: true as const },
  );

  const deps: InviteWorkerDeps = {
    teamRepository: teamRepository as unknown as ITeamRepository,
    authRepository: authRepository as unknown as IAuthRepository,
    send: send as unknown as InviteWorkerDeps['send'],
    businessName: async () => 'Maya Threads',
    appOrigin: 'https://shop.example.com',
    now: () => NOW,
  };

  return { deps, teamRepository, authRepository, send };
}

const job = { invitationId: 'invitation-1', tokenHash: TOKEN_HASH, token: TOKEN };

describe('processing an invitation email', () => {
  it('sends the invitation with the business, the inviter, and the expiring link', async () => {
    const { deps, teamRepository, send } = setup();

    const outcome = await processInviteEmailJob(deps, job, 1);

    expect(outcome).toEqual({ outcome: 'SENT' });
    expect(send).toHaveBeenCalledTimes(1);
    const [content, idempotencyKey] = send.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(content).toMatchObject({
      to: 'sam@example.com',
      businessName: 'Maya Threads',
      inviterName: 'Maya Owner',
      role: 'STAFF',
      inviteUrl: `https://shop.example.com/invite/${TOKEN}`,
      expiresAt: invitation().expiresAt,
      replyTo: 'maya@example.com',
    });
    expect(idempotencyKey).toBe(`invite:invitation-1:${TOKEN_HASH}`);
    expect(teamRepository.setEmailAttempts).toHaveBeenCalledWith('invitation-1', 1);
    expect(teamRepository.markEmailSent).toHaveBeenCalledWith('invitation-1', TOKEN_HASH);
  });

  it('ignores a token that was rotated after the job was queued', async () => {
    const frozen = setup({ invitation: invitation({ id: 'invitation-1' }) });
    // The row still exists, so the job looks live on its own. Rotate it first.
    const { deps, teamRepository, send } = frozen;

    const outcome = await processInviteEmailJob(deps, { ...job, tokenHash: 'old-hash' }, 1);

    expect(outcome).toEqual({ outcome: 'IGNORED', reason: 'TOKEN_CHANGED' });
    expect(send).not.toHaveBeenCalled();
    expect(teamRepository.markEmailSent).not.toHaveBeenCalled();
  });

  it('ignores a token whose invitation row is gone', async () => {
    const { deps, send } = setup({ invitation: null });

    const outcome = await processInviteEmailJob(deps, job, 1);

    expect(outcome.outcome).toBe('IGNORED');
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores an accepted invitation', async () => {
    const { deps, send } = setup({
      invitation: invitation({ acceptedAt: new Date(NOW.getTime() - 1000) }),
    });

    const outcome = await processInviteEmailJob(deps, job, 1);

    expect(outcome).toEqual({ outcome: 'IGNORED', reason: 'ACCEPTED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a cancelled invitation', async () => {
    const { deps, send } = setup({
      invitation: invitation({ revokedAt: new Date(NOW.getTime() - 1000) }),
    });

    const outcome = await processInviteEmailJob(deps, job, 1);

    expect(outcome).toEqual({ outcome: 'IGNORED', reason: 'REVOKED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('records an expired invitation as failed without sending', async () => {
    const { deps, teamRepository, send } = setup({
      invitation: invitation({ expiresAt: new Date(NOW.getTime() - 1000) }),
    });

    const outcome = await processInviteEmailJob(deps, job, 1);

    expect(outcome).toEqual({ outcome: 'FAILED', reason: 'INVITE_EXPIRED' });
    expect(send).not.toHaveBeenCalled();
    expect(teamRepository.markEmailFailed).toHaveBeenCalledWith(
      'invitation-1',
      TOKEN_HASH,
      'INVITE_EXPIRED',
    );
  });

  it('asks for a retry while attempts remain', async () => {
    const { deps, teamRepository } = setup({ sendOk: false, sendError: 'PROVIDER_RATE_LIMITED' });

    const outcome = await processInviteEmailJob(deps, job, 2);

    expect(outcome).toEqual({ outcome: 'RETRY', reason: 'PROVIDER_RATE_LIMITED' });
    expect(teamRepository.setEmailAttempts).toHaveBeenCalledWith('invitation-1', 2);
    expect(teamRepository.markEmailFailed).not.toHaveBeenCalled();
  });

  it('marks the invitation failed once every attempt is used', async () => {
    const { deps, teamRepository } = setup({ sendOk: false, sendError: 'PROVIDER_REJECTED' });

    const outcome = await processInviteEmailJob(deps, job, 4);

    expect(outcome).toEqual({ outcome: 'FAILED', reason: 'PROVIDER_REJECTED' });
    expect(teamRepository.markEmailFailed).toHaveBeenCalledWith(
      'invitation-1',
      TOKEN_HASH,
      'PROVIDER_REJECTED',
    );
  });
});
