import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeBoundary } from '@/components/theme/theme';
import { clearAuth, getAuth, setAuth } from '@/lib/auth-client';
import { render } from '@/test-utils/render';

const replaceMock = vi.fn();
const stableRouter = { replace: replaceMock, push: vi.fn() };
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/team',
  useRouter: () => stableRouter,
  useParams: () => ({ token: 'token-1' }),
}));

import TeamPage from './page';

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Builds an unsigned token payload, which is all the page reads. */
function token(payload: object): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

const OWNER_ID = 'user-owner';
const STAFF_ID = 'user-staff';

const teamBody = {
  success: true,
  data: {
    members: [
      {
        id: 'member-1',
        userId: OWNER_ID,
        name: 'Maya Owner',
        email: 'maya@example.com',
        role: 'OWNER',
        joinedAt: '2026-01-05T09:00:00.000Z',
      },
      {
        id: 'member-2',
        userId: STAFF_ID,
        name: 'Sam Staff',
        email: 'sam@example.com',
        role: 'STAFF',
        joinedAt: '2026-02-05T09:00:00.000Z',
      },
    ],
    invitations: [
      {
        id: 'invite-1',
        email: 'new@example.com',
        role: 'STAFF',
        invitedByName: 'Maya Owner',
        sentAt: null,
        createdAt: '2026-03-01T09:00:00.000Z',
        expiresAt: '2026-03-08T09:00:00.000Z',
        status: 'PENDING',
        emailStatus: 'SENT',
        emailError: null,
      },
    ],
  },
  message: 'Team loaded',
};

describe('TeamPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('lists members and invitations for an owner', async () => {
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(200, teamBody)),
    );

    render(
      <ThemeBoundary>
        <TeamPage />
      </ThemeBoundary>,
    );

    expect((await screen.findAllByText('Maya Owner'))[0]).toBeVisible();
    expect(screen.getAllByText('sam@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('new@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Email sent').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /send invitation/i })).toBeDisabled();
  });

  it('shows a read only view for staff', async () => {
    setAuth({ accessToken: token({ userId: STAFF_ID }), businessId: 'biz-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(200, teamBody)),
    );

    render(
      <ThemeBoundary>
        <TeamPage />
      </ThemeBoundary>,
    );

    expect((await screen.findAllByText('Sam Staff'))[0]).toBeVisible();
    expect(screen.queryByRole('button', { name: /send invitation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resend/i })).not.toBeInTheDocument();
    expect(screen.getAllByText('View only').length).toBeGreaterThan(0);
  });

  it('shows the one time link after sending an invitation', async () => {
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo) => {
      if (String(input).includes('/api/team/invitations')) {
        return jsonResponse(201, {
          success: true,
          data: {
            invitation: teamBody.data.invitations[0],
            inviteUrl: 'https://shop.example.com/invite/abc123',
            emailStatus: 'QUEUED',
            emailError: null,
          },
          message: 'Invitation created',
        });
      }
      return jsonResponse(200, teamBody);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ThemeBoundary>
        <TeamPage />
      </ThemeBoundary>,
    );

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email address/i), 'New@Example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    expect(await screen.findByText('https://shop.example.com/invite/abc123')).toBeVisible();
    expect(screen.getByText(/queued for sending/i)).toBeVisible();

    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/api/team/invitations'),
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      email: 'New@Example.com',
      role: 'STAFF',
    });
  });

  it('explains a pending duplicate instead of sending another', async () => {
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo) => {
        if (String(input).includes('/api/team/invitations')) {
          return jsonResponse(409, {
            error: 'INVITE_ALREADY_PENDING',
            message: 'An invitation is already pending',
            invitationId: 'invite-1',
          });
        }
        return jsonResponse(200, teamBody);
      }),
    );

    render(
      <ThemeBoundary>
        <TeamPage />
      </ThemeBoundary>,
    );

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email address/i), 'new@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    expect(await screen.findByText(/already has a pending invitation/i)).toBeVisible();
  });

  it('clears the session when the API denies business access', async () => {
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        jsonResponse(403, {
          error: 'BUSINESS_ACCESS_DENIED',
          message: 'You do not have access to this business',
        }),
      ),
    );

    render(
      <ThemeBoundary>
        <TeamPage />
      </ThemeBoundary>,
    );

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    expect(getAuth()).toBeNull();
    clearAuth();
  });

  it('offers a retry when loading fails for another reason', async () => {
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'Something broke' }),
      )
      .mockImplementation(async () => jsonResponse(200, teamBody));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ThemeBoundary>
        <TeamPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText('Something broke')).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect((await screen.findAllByText('Maya Owner'))[0]).toBeVisible();
  });
});
