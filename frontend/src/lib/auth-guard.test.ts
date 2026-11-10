import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { clearAuth, setAuth } from '@/lib/auth-client';
import { useRequireAuth } from '@/lib/auth-guard';

// Supports AC-7: an invitation page reads the session but never redirects a
// signed in visitor away, so the link works in place for whoever opened it.

const replaceMock = vi.fn();

// mock next/navigation BEFORE importing the hook under test
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

describe('useRequireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  describe('protected route (requireAuth: true, the default)', () => {
    it('redirects to /login and reports not-ready when no session is present', () => {
      const { result } = renderHook(() => useRequireAuth());

      expect(replaceMock).toHaveBeenCalledWith('/login');
      // redirecting visitors should not render guarded content
      expect(result.current).toBe(false);
    });

    it('renders immediately (ready) when a session is present', () => {
      window.localStorage.setItem('accessToken', 'tok');
      window.localStorage.setItem('businessId', 'biz-1');

      const { result } = renderHook(() => useRequireAuth());

      expect(replaceMock).not.toHaveBeenCalled();
      expect(result.current).toBe(true);
    });

    it('redirects when only a stale accessToken is stored', () => {
      window.localStorage.setItem('accessToken', 'tok');

      renderHook(() => useRequireAuth());

      expect(replaceMock).toHaveBeenCalledWith('/login');
    });

    // covers AC-15: apiFetch clears the session, and the guard owns the redirect.
    it('redirects to /login when the session is cleared while mounted', async () => {
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      const { result } = renderHook(() => useRequireAuth());

      expect(result.current).toBe(true);
      expect(replaceMock).not.toHaveBeenCalled();

      act(() => clearAuth());

      await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
      expect(result.current).toBe(false);
    });
  });

  describe('public-only route (requireAuth: false)', () => {
    it('renders immediately (ready) when there is no session', () => {
      const { result } = renderHook(() => useRequireAuth({ requireAuth: false }));

      expect(replaceMock).not.toHaveBeenCalled();
      expect(result.current).toBe(true);
    });

    it('redirects to /onboarding and reports not-ready when a session is present', () => {
      window.localStorage.setItem('accessToken', 'tok');
      window.localStorage.setItem('businessId', 'biz-1');

      const { result } = renderHook(() => useRequireAuth({ requireAuth: false }));

      // /onboarding is the single entry point after auth; it redirects to /dashboard if complete
      expect(replaceMock).toHaveBeenCalledWith('/onboarding');
      expect(result.current).toBe(false);
    });

    it('awaits a redirect resolver before navigating, so the destination is resolved once', async () => {
      window.localStorage.setItem('accessToken', 'tok');
      window.localStorage.setItem('businessId', 'biz-1');
      const resolve = vi.fn().mockResolvedValue('/dashboard');

      renderHook(() => useRequireAuth({ requireAuth: false, redirectTo: resolve }));

      expect(replaceMock).not.toHaveBeenCalled();
      await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it('falls back to /onboarding when the resolver rejects', async () => {
      window.localStorage.setItem('accessToken', 'tok');
      window.localStorage.setItem('businessId', 'biz-1');
      const resolve = vi.fn().mockRejectedValue(new Error('profile unavailable'));

      renderHook(() => useRequireAuth({ requireAuth: false, redirectTo: resolve }));

      // The rejection must not become an unhandled promise rejection, and the
      // wizard is the safe landing spot when the destination is unknown.
      await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/onboarding'));
      expect(resolve).toHaveBeenCalledTimes(1);
    });
  });

  describe('public route that also serves a signed in visitor', () => {
    it('keeps a signed in visitor on the page and renders it', () => {
      window.localStorage.setItem('accessToken', 'tok');
      window.localStorage.setItem('businessId', 'biz-1');

      const { result } = renderHook(() =>
        useRequireAuth({ requireAuth: false, redirectAuthenticated: false }),
      );

      // The invitation page reads the session but must never send the visitor
      // away: the link has to work in place for whoever opened it.
      expect(replaceMock).not.toHaveBeenCalled();
      expect(result.current).toBe(true);
    });

    it('still renders for a signed out visitor', () => {
      const { result } = renderHook(() =>
        useRequireAuth({ requireAuth: false, redirectAuthenticated: false }),
      );

      expect(replaceMock).not.toHaveBeenCalled();
      expect(result.current).toBe(true);
    });
  });
});
