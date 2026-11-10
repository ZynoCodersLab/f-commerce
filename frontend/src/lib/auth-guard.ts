import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { getAuth, subscribeToAuth } from '@/lib/auth-client';

function subscribeToSession(onChange: () => void): () => void {
  // The auth store covers changes made in this tab, such as clearing the
  // session after a BUSINESS_ACCESS_DENIED response. The storage event covers
  // another tab. Together the guard redirects on both.
  const unsubscribeAuth = subscribeToAuth(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    unsubscribeAuth();
    window.removeEventListener('storage', onChange);
  };
}

interface RequireAuthOptions {
  /** true (default) for protected routes, false for public-only routes. */
  requireAuth?: boolean;
  /**
   * Where an authenticated visitor on a public route goes. A string is used as
   * is; a resolver is awaited, so a page can ask the API where the member
   * belongs before the first navigation happens. Defaults to `/onboarding`.
   *
   * Ignored for protected routes, which always go to `/login`.
   */
  redirectTo?: string | (() => string | Promise<string>);
  /**
   * true (default) sends an authenticated visitor away from a public route.
   * Set false for a public route that must also serve signed in visitors, such
   * as the invitation page: the session is read, but nobody is redirected.
   */
  redirectAuthenticated?: boolean;
}

/**
 * Route-protection hook for the custom localStorage JWT auth model.
 *
 * There is no edge-readable session cookie, so protection happens
 * client-side. The session is read through useSyncExternalStore with a null
 * server snapshot, so the server render and hydration both report not-ready.
 *
 * @param options.requireAuth - true (default) for protected routes:
 *   unauthenticated visitors are redirected to `/login`.
 *   false for public-only routes (e.g. /login): authenticated visitors
 *   are redirected to `redirectTo`.
 * @returns `ready` — false until the session has been read on the client and
 *   any redirect is ruled out, true once the user is allowed to see the page.
 */
export function useRequireAuth(options?: RequireAuthOptions): boolean {
  const requireAuth = options?.requireAuth ?? true;
  const redirectTo = options?.redirectTo;
  const redirectAuthenticated = options?.redirectAuthenticated ?? true;
  const router = useRouter();
  const authed = useSyncExternalStore<boolean | null>(
    subscribeToSession,
    () => !!getAuth(),
    () => null,
  );

  const shouldRedirect =
    authed !== null && (requireAuth ? !authed : redirectAuthenticated && authed);

  useEffect(() => {
    if (!shouldRedirect) return;

    // One redirect, one owner. A page that needs a resolved destination (the
    // sign-in page does) passes a resolver instead of racing a second navigation
    // from its own submit handler.
    let cancelled = false;
    const target = requireAuth ? '/login' : (redirectTo ?? '/onboarding');

    void (async () => {
      let path: string;
      try {
        path = typeof target === 'function' ? await target() : target;
      } catch {
        // An unknown destination is better than no navigation at all: the
        // wizard handles both finished and unfinished members.
        path = '/onboarding';
      }
      if (!cancelled) router.replace(path);
    })();

    return () => {
      cancelled = true;
    };
  }, [redirectTo, requireAuth, router, shouldRedirect]);

  return authed !== null && !shouldRedirect;
}
