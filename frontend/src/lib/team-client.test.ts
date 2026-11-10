import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamInvitation, TeamMember } from '@f-commerce/contracts';
import {
  TeamApiError,
  cancelInvite,
  createInvite,
  fetchInvitePreview,
  removeMember,
  resendInvite,
  updateMemberRole,
} from './team-client';
import type { InviteSendResult, TeamErrorBody } from './team-client';
import { apiFetch, isTimeoutError } from './auth-client';

// Keep the real timeout helper and error type; stub only the authenticated
// request so the write methods can be checked without a server.
vi.mock('./auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth-client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

const invitation: TeamInvitation = {
  id: 'invitation-1',
  email: 'sam@example.com',
  role: 'STAFF',
  invitedByName: 'Maya Owner',
  sentAt: null,
  lastSentAt: '2026-03-01T09:00:00.000Z',
  createdAt: '2026-03-01T09:00:00.000Z',
  expiresAt: '2026-03-08T09:00:00.000Z',
  status: 'PENDING',
  emailStatus: 'QUEUED',
  emailError: null,
};

const sendResult: InviteSendResult = {
  invitation,
  inviteUrl: 'https://shop.example.com/invite/raw-token',
  emailStatus: 'QUEUED',
  emailError: null,
};

const member: TeamMember = {
  id: 'membership-1',
  userId: 'user-invitee',
  name: 'Sam Staff',
  email: 'sam@example.com',
  role: 'STAFF',
  joinedAt: '2026-03-01T09:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('team write requests', () => {
  it('creates an invitation and unwraps the send result', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: sendResult, message: 'Invitation sent' }),
    );

    await expect(createInvite({ email: 'sam@example.com' })).resolves.toEqual(sendResult);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/team/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sam@example.com' }),
    });
  });

  it('resends an invitation to an encoded id', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: sendResult, message: 'Invitation resent' }),
    );

    await expect(resendInvite('invite/one')).resolves.toEqual(sendResult);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/team/invitations/invite%2Fone/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
  });

  it('cancels an invitation with a delete and accepts no body', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: null, message: 'Invitation cancelled' }),
    );

    await expect(cancelInvite('invite/one')).resolves.toBeUndefined();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/team/invitations/invite%2Fone', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
  });

  it('updates a member role with the requested role', async () => {
    const updated = { ...member, role: 'OWNER' as const };
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: updated, message: 'Role updated' }),
    );

    await expect(updateMemberRole('member/one', { role: 'OWNER' })).resolves.toEqual(updated);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/team/members/member%2Fone', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'OWNER' }),
    });
  });

  it('removes a member with a delete and accepts no body', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(removeMember('member/one')).resolves.toBeUndefined();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/team/members/member%2Fone', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    });
  });
});

describe('team error parsing', () => {
  const cases: Array<{
    label: string;
    status: number;
    body: TeamErrorBody;
    message: string;
  }> = [
    {
      label: 'a pending conflict that names the live invitation',
      status: 409,
      body: {
        error: 'INVITE_ALREADY_PENDING',
        message: 'An invitation is already pending for this address',
        invitationId: 'invitation-1',
      },
      message: 'An invitation is already pending for this address',
    },
    {
      label: 'a business access refusal',
      status: 403,
      body: { error: 'BUSINESS_ACCESS_DENIED', message: 'You cannot manage this business' },
      message: 'You cannot manage this business',
    },
    {
      label: 'a rate limit with no message',
      status: 429,
      body: { error: 'RATE_LIMITED' },
      message: 'RATE_LIMITED',
    },
  ];

  it.each(cases)('turns $label into a TeamApiError', async ({ status, body, message }) => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(body, status));

    const failure = await cancelInvite('invitation-1').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TeamApiError);
    expect(failure).toMatchObject({
      name: 'TeamApiError',
      message,
      status,
      code: body.error,
      body,
    });
  });

  it('keeps only string field names from a validation failure', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'VALIDATION_ERROR', fields: ['email', 7, null] }, 400),
    );

    const failure = await cancelInvite('invitation-1').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TeamApiError);
    expect((failure as TeamApiError).fields).toEqual(['email']);
    expect((failure as TeamApiError).message).toBe('VALIDATION_ERROR');
  });
});

// The public preview is the only request that carries no session, but it must
// still give up on a stalled connection so the invite page can show its error
// state instead of a skeleton that never resolves (AC-21).
describe('fetchInvitePreview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('stops waiting after the shared timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchInvitePreview('token-1');
    const rejection = expect(pending).rejects.toSatisfy(isTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns the preview when the request resolves', async () => {
    const preview = { businessName: 'Maya Threads', email: 'new@example.com' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: preview }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(fetchInvitePreview('token-1')).resolves.toEqual(preview);
  });
});
