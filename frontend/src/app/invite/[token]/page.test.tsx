import { screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByLabelText(/password/i)).toBeVisible();
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
    await user.type(screen.getByLabelText(/password/i), 'correct horse');
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
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
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

    await waitFor(() => expect(replaceMock).toHaveBeenCalled(), { timeout: 3000 });
    expect(replaceMock).not.toHaveBeenCalledWith('/login');
  });
});
