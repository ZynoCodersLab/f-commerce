import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeBoundary } from '@/components/theme/theme';
import { getAuth, setAuth } from '@/lib/auth-client';
import { render } from '@/test-utils/render';

const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/invite/token-1',
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useParams: () => ({ token: 'token-1' }),
}));

import InvitePage from './page';

// Covers AC-6, AC-7, AC-8, AC-9, and AC-21 on the public invite page: the
// preview, inline acceptance, sign in first states, and the error states.

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const preview = {
  businessName: 'Maya Threads',
  inviterName: 'Maya Owner',
  email: 'new@example.com',
  role: 'STAFF',
  expiresAt: '2026-03-08T09:00:00.000Z',
  accountExists: false,
  hasPassword: false,
  alreadyMember: false,
};

describe('InvitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('describes the invitation before asking for a password', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(200, { success: true, data: preview })),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText(/Maya Owner invited you/i)).toBeVisible();
    expect(screen.getAllByText('new@example.com').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/your name/i)).toBeVisible();
    expect(screen.getByLabelText(/^password$/i)).toBeVisible();
    expect(screen.getByLabelText(/confirm password/i)).toBeVisible();
  });

  it('shows the expiry in the invited business timezone, even when signed out', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          jsonResponse(200, { success: true, data: { ...preview, timezone: 'UTC' } }),
        ),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText(/link expires/i)).toBeVisible();
    // 09:00 UTC, not 15:00 in the signed out default zone.
    expect(await screen.findByText(/9:00/)).toBeVisible();
  });

  it('joins and stores the session after setting a password', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo) => {
      if (String(input).includes('/accept')) {
        return jsonResponse(200, {
          success: true,
          data: { accessToken: 'new-token', businessId: 'biz-9' },
          message: 'Joined',
        });
      }
      return jsonResponse(200, { success: true, data: preview });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/your name/i), 'New Person');
    await user.type(screen.getByLabelText(/^password$/i), 'correct horse');
    await user.type(screen.getByLabelText(/confirm password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: /join maya threads/i }));

    await vi.waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
    expect(getAuth()).toEqual({ accessToken: 'new-token', businessId: 'biz-9' });
  });

  it('asks an existing account holder to sign in first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () =>
        jsonResponse(200, {
          success: true,
          data: { ...preview, accountExists: true, hasPassword: true },
        }),
      ),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText(/already has an account/i)).toBeVisible();
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
  });

  it('explains an expired link', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          jsonResponse(410, { error: 'INVITE_EXPIRED', message: 'Invitation expired' }),
        ),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText(/invitation has expired/i)).toBeVisible();
  });

  it('asks a rate limited visitor to try again later', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          jsonResponse(429, { error: 'RATE_LIMITED', message: 'Too many requests' }),
        ),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText(/too many attempts/i)).toBeVisible();
    expect(screen.getByText(/try again later/i)).toBeVisible();
  });

  it('keeps an already signed in visitor on the invite page', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
    expect(window.localStorage.getItem('accessToken')).toBe('tok');
    expect(window.localStorage.getItem('businessId')).toBe('biz-1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo) => {
        if (String(input).includes('/api/auth/me')) {
          return jsonResponse(200, {
            user: { id: 'u1', email: 'new@example.com', name: 'New', isActive: true },
            businesses: [],
          });
        }
        return jsonResponse(200, {
          success: true,
          data: { ...preview, accountExists: true, hasPassword: true },
        });
      }),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText(/Maya Owner invited you/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /join maya threads/i })).toBeVisible();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('accepts in place for a signed in account without sending a name', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
    let acceptBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/auth/me')) {
        return jsonResponse(200, {
          user: { id: 'u1', email: 'new@example.com', name: 'New', isActive: true },
          businesses: [],
        });
      }
      if (url.includes('/accept')) {
        acceptBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return jsonResponse(200, {
          success: true,
          data: { accessToken: 'new-token', businessId: 'biz-9' },
          message: 'Joined',
        });
      }
      return jsonResponse(200, {
        success: true,
        data: { ...preview, accountExists: true, hasPassword: true },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText(/signed in as/i)).toBeVisible();
    // The account already has a name and a password, so the page asks for
    // neither. Accepting uses the signed in session alone (AC-8).
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /join maya threads/i }));

    await vi.waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
    expect(acceptBody).toEqual({});
    expect(getAuth()).toEqual({ accessToken: 'new-token', businessId: 'biz-9' });
  });

  it('blocks joining until the password confirmation matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => jsonResponse(200, { success: true, data: preview })),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^password$/i), 'correct horse');
    await user.type(screen.getByLabelText(/confirm password/i), 'wrong horse');

    expect(screen.getByText(/do not match/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /join maya threads/i })).toBeDisabled();

    await user.clear(screen.getByLabelText(/confirm password/i));
    await user.type(screen.getByLabelText(/confirm password/i), 'correct horse');
    expect(screen.getByRole('button', { name: /join maya threads/i })).toBeEnabled();
  });

  it('never posts the password confirmation', async () => {
    let acceptBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        if (String(input).includes('/accept')) {
          acceptBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          return jsonResponse(200, {
            success: true,
            data: { accessToken: 'new-token', businessId: 'biz-9' },
            message: 'Joined',
          });
        }
        return jsonResponse(200, { success: true, data: preview });
      }),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^password$/i), 'correct horse');
    await user.type(screen.getByLabelText(/confirm password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: /join maya threads/i }));

    await vi.waitFor(() => expect(acceptBody).not.toBeNull());
    expect(acceptBody).toEqual({ password: 'correct horse' });
  });

  it('asks a signed in visitor with another account to sign out', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo) => {
        if (String(input).includes('/api/auth/me')) {
          return jsonResponse(200, {
            user: { id: 'u1', email: 'someone@example.com', name: 'Other', isActive: true },
            businesses: [],
          });
        }
        return jsonResponse(200, { success: true, data: preview });
      }),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText(/invitation is for/i)).toBeVisible();
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeVisible();
  });

  it('names the invited member instead of calling the visitor a member', async () => {
    // The invited email already joined, so nobody can accept this link, and a
    // visitor signed in with another account must not be told they joined.
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo) => {
        if (String(input).includes('/api/auth/me')) {
          return jsonResponse(200, {
            user: { id: 'u1', email: 'someone@example.com', name: 'Other', isActive: true },
            businesses: [],
          });
        }
        return jsonResponse(200, {
          success: true,
          data: { ...preview, alreadyMember: true },
        });
      }),
    );

    render(
      <ThemeBoundary>
        <InvitePage />
      </ThemeBoundary>,
    );

    expect((await screen.findAllByText(/already a member/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/You are already a member/i)).toBeNull();
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeVisible();
  });
});
