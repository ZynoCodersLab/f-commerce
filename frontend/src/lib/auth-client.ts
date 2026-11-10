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

export async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const authHeaders = getAuthHeaders();
  Object.entries(authHeaders).forEach(([key, value]) => {
    headers.set(key, value);
  });

  const response = await fetchWithTimeout(input, { ...init, headers });
  await clearSessionOnBusinessAccessDenied(response);
  return response;
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
