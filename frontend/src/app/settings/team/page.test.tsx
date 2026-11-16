import { act, screen, waitFor } from '@testing-library/react';
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

// Covers AC-2, AC-5, AC-15, and AC-21 on the team screen: the owner and staff
// views, the pending list, the one time link, access denial, and retry states.

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
        sentAt: '2026-03-01T09:05:00.000Z',
        lastSentAt: '2026-03-01T09:05:00.000Z',
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
    vi.useRealTimers();
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
    // The owner id is read in a deferred effect, so wait for the owner view.
    expect(await screen.findByRole('button', { name: /send invitation/i })).toBeDisabled();
    // The self row explains why its role and remove controls are disabled
    // instead of hiding the reason in a title, which keyboard users cannot reach.
    expect(
      (await screen.findAllByText(/cannot change your own role or remove yourself/i)).length,
    ).toBeGreaterThan(0);
  });

  it('labels a queued invitation with its last attempt instead of not yet', async () => {
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    const queuedBody = {
      ...teamBody,
      data: {
        ...teamBody.data,
        invitations: [
          {
            ...teamBody.data.invitations[0],
            sentAt: null,
            lastSentAt: '2026-03-01T09:05:00.000Z',
            emailStatus: 'QUEUED',
          },
        ],
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(200, queuedBody)),
    );

    render(
      <ThemeBoundary>
        <TeamPage />
      </ThemeBoundary>,
    );

    expect((await screen.findAllByText(/Queued/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Not yet')).not.toBeInTheDocument();
  });

  it('backs off polling after a minute while an invitation stays queued', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    const queuedBody = {
      ...teamBody,
      data: {
        ...teamBody.data,
        invitations: [{ ...teamBody.data.invitations[0], emailStatus: 'QUEUED' }],
      },
    };
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(200, queuedBody));
    vi.stubGlobal('fetch', fetchMock);
    const teamCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input) === '/api/team').length;

    render(
      <ThemeBoundary>
        <TeamPage />
      </ThemeBoundary>,
    );

    // Let the first load settle while the clock is frozen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(teamCalls()).toBe(1);

    // Twelve five second polls cover the first minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(teamCalls()).toBe(13);

    // The next poll is thirty seconds away, not five.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(teamCalls()).toBe(13);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(teamCalls()).toBe(14);
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

  it('explains a resend conflict without promising a link that is not shown', async () => {
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo) => {
        if (String(input).includes('/resend')) {
          return jsonResponse(409, {
            error: 'INVITE_RESEND_CONFLICT',
            message: 'The invitation changed',
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
    const resendButtons = await screen.findAllByRole('button', { name: /resend/i });
    await user.click(resendButtons[0]);

    expect(await screen.findByText(/just resent from somewhere else/i)).toBeVisible();
    expect(screen.queryByText(/newest link is below/i)).not.toBeInTheDocument();
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

  it('keeps the confirmation open and shows the error when a cancel fails', async () => {
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_input: RequestInfo, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          return jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'Something broke' });
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
    const cancelButtons = await screen.findAllByRole('button', { name: /^cancel$/i });
    await user.click(cancelButtons[0]);
    await user.click(await screen.findByRole('button', { name: /cancel invitation/i }));

    // The dialog stays open with its message, so a failed removal is never
    // mistaken for success.
    expect(await screen.findByText(/that did not work/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /cancel invitation/i })).toBeVisible();
  });

  it('keeps role control ids unique across the table and card views', async () => {
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

    await screen.findAllByText('Maya Owner');

    // The signed in id is read after mount, so wait for the owner controls
    // before collecting ids.
    await waitFor(() => {
      expect(document.querySelectorAll('[id^="role-"]').length).toBeGreaterThan(0);
    });

    // Both the desktop table and the mobile card grid stay mounted, so each
    // member has two role controls. Their ids must not collide (AC-21).
    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id^="role-"]')).map(
      (element) => element.id,
    );
    expect(new Set(ids).size).toBe(ids.length);

    for (const label of document.querySelectorAll<HTMLLabelElement>('label[for]')) {
      expect(document.getElementById(label.htmlFor)).not.toBeNull();
    }
  });

  it('clears the one time link when its invitation is cancelled', async () => {
    setAuth({ accessToken: token({ userId: OWNER_ID }), businessId: 'biz-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          return jsonResponse(200, { success: true, data: {} });
        }
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
      }),
    );

    render(
      <ThemeBoundary>
        <TeamPage />
      </ThemeBoundary>,
    );

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email address/i), 'New@Example.com');
    await user.click(screen.getByRole('button', { name: /send invitation/i }));
    expect(await screen.findByText('https://shop.example.com/invite/abc123')).toBeVisible();

    const cancelButtons = await screen.findAllByRole('button', { name: /^cancel$/i });
    await user.click(cancelButtons[0]);
    await user.click(await screen.findByRole('button', { name: /cancel invitation/i }));

    await waitFor(() =>
      expect(screen.queryByText('https://shop.example.com/invite/abc123')).not.toBeInTheDocument(),
    );
  });
});
