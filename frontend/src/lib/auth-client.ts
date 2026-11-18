import { removeBusinessSettingsCache } from './business-settings-cache';

const TOKEN_KEY = 'accessToken';
const BUSINESS_ID_KEY = 'businessId';

type AuthListener = () => void;
const authListeners = new Set<AuthListener>();

/** Notify the shared business settings provider when the active auth changes. */
export function subscribeToAuth(listener: AuthListener): () => void {
  authListeners.add(listener);
  return () => {
    authListeners.delete(listener);
  };
}

function notifyAuthChange(): void {
  authListeners.forEach((listener) => listener());
}

export interface AuthUser {
  accessToken: string;
  businessId: string;
}

export function setAuth(user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, user.accessToken);
  localStorage.setItem(BUSINESS_ID_KEY, user.businessId);
  notifyAuthChange();
}

export function getAuth(): AuthUser | null {
  const accessToken = localStorage.getItem(TOKEN_KEY);
  const businessId = localStorage.getItem(BUSINESS_ID_KEY);
  if (!accessToken || !businessId) return null;
  return { accessToken, businessId };
}

export function clearAuth(): void {
  const businessId = localStorage.getItem(BUSINESS_ID_KEY);
  if (businessId) removeBusinessSettingsCache(businessId);

  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(BUSINESS_ID_KEY);
  notifyAuthChange();
}

export function getAuthHeaders(): Record<string, string> {
  const auth = getAuth();
  if (!auth) return {};
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    'x-business-id': auth.businessId,
  };
}

/** Every request gives up after this long. A timed out request is never retried. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * True when a rejected fetch came from our timeout rather than the network.
 * A caller uses this to reload and reconcile instead of assuming failure.
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

/**
 * Fetch with the shared timeout and no auth headers. A public endpoint uses it,
 * so a stalled proxy fails like any other request instead of hanging the page.
 */
export async function fetchWithTimeout(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    REQUEST_TIMEOUT_MS,
  );

  try {
    // Pass relative paths through directly. Next.js rewrites in next.config.ts
    // forward /api/* to the Express backend, which works in both dev and
    // production. No hardcoded host means this works in any deployment.
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** The API's code for a missing, removed, or inactive membership. */
const BUSINESS_ACCESS_DENIED = 'BUSINESS_ACCESS_DENIED';

/**
 * Drop the session when the API denies access because the membership is gone
 * (AC-15, AC-17). The route guard sees the cleared session and returns the
 * member to /login, so every screen behaves the same way, not just the team
 * screen.
 *
 * The body is read from a clone, and only on a 403, so the caller still
 * receives the untouched response.
 */
async function clearSessionOnBusinessAccessDenied(response: Response): Promise<void> {
  if (response.status !== 403) return;

  try {
    const payload: unknown = await response.clone().json();
    if (
      typeof payload === 'object' &&
      payload !== null &&
      (payload as { error?: unknown }).error === BUSINESS_ACCESS_DENIED
    ) {
      clearAuth();
    }
  } catch {
    // Not JSON, so this is not the membership error. Leave the session alone.
  }
}

type RefreshResult =
  | { outcome: 'refreshed'; accessToken: string }
  | { outcome: 'rejected' }
  | { outcome: 'unavailable' };

/**
 * One refresh at a time per tab. Concurrent 401 responses await the same
 * request, so several panels do not rotate the refresh token several times.
 */
let refreshInFlight: Promise<RefreshResult> | null = null;

function requestPath(input: RequestInfo): string {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }
  return url.split('?')[0];
}

/**
 * Auth routes answer 401 for a bad credential or an expired refresh cookie.
 * That is the answer the caller asked for, so it must not trigger a refresh
 * and replay the request.
 */
function isAuthEndpoint(input: RequestInfo): boolean {
  return requestPath(input).startsWith('/api/auth/');
}

async function readAccessToken(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null) return null;
    const token = (payload as { accessToken?: unknown }).accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function requestRefresh(): Promise<RefreshResult> {
  const session = getAuth();
  if (!session) return { outcome: 'rejected' };

  let response: Response;
  try {
    response = await fetchWithTimeout('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // The API could not be reached or the request timed out. Keep the session:
    // the refresh cookie may still be valid when the API returns.
    return { outcome: 'unavailable' };
  }

  if (response.status === 400 || response.status === 401) {
    return { outcome: 'rejected' };
  }
  if (!response.ok) {
    return { outcome: 'unavailable' };
  }

  const accessToken = await readAccessToken(response);
  if (!accessToken) {
    return { outcome: 'unavailable' };
  }

  // A sign out or a business switch while the refresh was in flight wins.
  const active = getAuth();
  if (!active || active.businessId !== session.businessId) {
    return { outcome: 'rejected' };
  }

  // The user and business are unchanged, so only the token moves. Do not
  // notify auth listeners: a token refresh must not reload business settings.
  localStorage.setItem(TOKEN_KEY, accessToken);
  return { outcome: 'refreshed', accessToken };
}

function refreshSession(): Promise<RefreshResult> {
  if (!refreshInFlight) {
    refreshInFlight = requestRefresh()
      .catch((): RefreshResult => ({ outcome: 'unavailable' }))
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function sendWithAuth(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const authHeaders = getAuthHeaders();
  Object.entries(authHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  return fetchWithTimeout(input, { ...init, headers });
}

/**
 * Adds the session headers and sends the request. A 401 refreshes the access
 * token once and replays the request once. A rejected refresh clears the
 * session; an unreachable refresh keeps it, so a later request can try again.
 * Auth routes are never refreshed, because their 401 is the answer the caller
 * asked for.
 */
export async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  let response = await sendWithAuth(input, init);

  if (response.status === 401 && getAuth() && !isAuthEndpoint(input)) {
    const refresh = await refreshSession();
    if (refresh.outcome === 'refreshed') {
      response = await sendWithAuth(input, init);
    } else if (refresh.outcome === 'rejected' && getAuth()) {
      // A sign out may have won while the refresh was in flight.
      clearAuth();
    }
  }

  await clearSessionOnBusinessAccessDenied(response);
  return response;
}

/**
 * Revoke the refresh cookie, then clear the local session. The local clear
 * always runs, so an unreachable API cannot leave the browser signed in.
 */
export async function logout(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    // The refresh cookie may survive, but the local session must not.
  } finally {
    clearAuth();
  }
}

/**
 * Reads the user id from an access token payload without verifying it. The team
 * screen uses it only to tell the caller apart from other members, so an absent
 * or unreadable token is treated as "not the caller" rather than an error.
 */
export function getUserIdFromToken(token: string | null): string | null {
  if (!token) return null;
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    // JWT segments are base64url and usually unpadded, which atob rejects.
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const decoded = JSON.parse(atob(padded)) as { userId?: unknown };
    return typeof decoded.userId === 'string' ? decoded.userId : null;
  } catch {
    return null;
  }
}
