import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiFetch,
  clearAuth,
  getAuth,
  getAuthHeaders,
  getUserIdFromToken,
  isTimeoutError,
  setAuth,
  subscribeToAuth,
} from '@/lib/auth-client';
import {
  businessSettingsCacheKey,
  writeBusinessSettingsCache,
} from '@/lib/business-settings-cache';

const TOKEN_KEY = 'accessToken';
const BUSINESS_ID_KEY = 'businessId';

describe('auth-client', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('setAuth / getAuth', () => {
    it('stores the token and business id, returns them on getAuth', () => {
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });

      expect(getAuth()).toEqual({ accessToken: 'tok', businessId: 'biz-1' });
    });

    it('returns null when the token is missing', () => {
      window.localStorage.setItem(BUSINESS_ID_KEY, 'biz-1');
      expect(getAuth()).toBeNull();
    });

    it('returns null when the business id is missing', () => {
      window.localStorage.setItem(TOKEN_KEY, 'tok');
      expect(getAuth()).toBeNull();
    });

    it('returns null when nothing is stored', () => {
      expect(getAuth()).toBeNull();
    });

    it('clearAuth removes both keys', () => {
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      clearAuth();
      expect(getAuth()).toBeNull();
    });
  });

  // covers AC-7: the shared settings provider reloads when the active auth changes.
  describe('subscribeToAuth', () => {
    it('notifies listeners on setAuth and clearAuth', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeToAuth(listener);

      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      expect(listener).toHaveBeenCalledTimes(1);

      clearAuth();
      expect(listener).toHaveBeenCalledTimes(2);

      unsubscribe();
    });

    it('stops notifying after the listener unsubscribes', () => {
      const listener = vi.fn();
      subscribeToAuth(listener)();

      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      clearAuth();

      expect(listener).not.toHaveBeenCalled();
    });

    it('removes only the active business cache on clearAuth', () => {
      writeBusinessSettingsCache('biz-1', { currency: 'USD', timezone: 'America/New_York' });
      writeBusinessSettingsCache('biz-2', { currency: 'EUR', timezone: 'Europe/Paris' });
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });

      clearAuth();

      expect(window.localStorage.getItem(businessSettingsCacheKey('biz-1'))).toBeNull();
      expect(window.localStorage.getItem(businessSettingsCacheKey('biz-2'))).not.toBeNull();
    });
  });

  describe('getAuthHeaders', () => {
    it('returns the bearer token and business id header when authed', () => {
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      expect(getAuthHeaders()).toEqual({
        Authorization: 'Bearer tok',
        'x-business-id': 'biz-1',
      });
    });

    it('returns an empty object when unauthenticated', () => {
      expect(getAuthHeaders()).toEqual({});
    });
  });

  describe('getUserIdFromToken', () => {
    // A JWT segment is base64url and usually unpadded, which bare atob rejects.
    function tokenFor(payload: object): string {
      const segment = btoa(JSON.stringify(payload))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      return `header.${segment}.signature`;
    }

    it('reads the user id from an unpadded base64url payload', () => {
      expect(getUserIdFromToken(tokenFor({ userId: 'user-42' }))).toBe('user-42');
    });

    it('returns null when the token has no user id', () => {
      expect(getUserIdFromToken(tokenFor({ memberships: [] }))).toBeNull();
    });

    it('returns null for a token that cannot be decoded', () => {
      expect(getUserIdFromToken('not-a-jwt')).toBeNull();
      expect(getUserIdFromToken(null)).toBeNull();
    });
  });

  describe('apiFetch', () => {
    it('passes relative paths through to fetch for the Next.js rewrite to handle', async () => {
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);

      await apiFetch('/api/business/me', { method: 'GET' });

      expect(fetchMock).toHaveBeenCalledWith('/api/business/me', expect.anything());
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer tok');
      expect(headers.get('x-business-id')).toBe('biz-1');
    });

    it('leaves the headers empty when there is no session', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);

      await apiFetch('/api/business/me', { method: 'GET' });

      expect(fetchMock).toHaveBeenCalledWith('/api/business/me', expect.anything());
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Headers;
      expect(headers.get('Authorization')).toBeNull();
      expect(headers.get('x-business-id')).toBeNull();
    });

    it('preserves caller-provided headers and only adds auth ones', async () => {
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);

      await apiFetch('/api/business/logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Headers;
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('Authorization')).toBe('Bearer tok');
    });

    it('passes through the response from fetch', async () => {
      const fake = new Response('done', { status: 200 });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fake));

      const res = await apiFetch('/api/business/me');

      expect(res).toBe(fake);
    });

    it('passes through already-absolute URLs unchanged', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', fetchMock);

      await apiFetch('https://example.com/path');

      expect(fetchMock).toHaveBeenCalledWith('https://example.com/path', expect.anything());
    });

    // covers AC-15: a removed member loses the session on the next business request.
    it('clears the session when the API denies access by membership', async () => {
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      const listener = vi.fn();
      const unsubscribe = subscribeToAuth(listener);
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ error: 'BUSINESS_ACCESS_DENIED' }), { status: 403 }),
          ),
      );

      const response = await apiFetch('/api/orders');

      // The caller still gets the untouched response to report.
      expect(response.status).toBe(403);
      expect(getAuth()).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it('keeps the session for another 403', async () => {
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 })),
      );

      await apiFetch('/api/orders');

      expect(getAuth()).toEqual({ accessToken: 'tok', businessId: 'biz-1' });
    });

    it('keeps the session when a 403 body is not JSON', async () => {
      setAuth({ accessToken: 'tok', businessId: 'biz-1' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));

      await apiFetch('/api/orders');

      expect(getAuth()).toEqual({ accessToken: 'tok', businessId: 'biz-1' });
    });
  });

  describe('request timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('aborts the request after the timeout window', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(
        (_input: RequestInfo, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = apiFetch('/api/business/me');
      const rejection = expect(pending).rejects.toSatisfy(isTimeoutError);
      await vi.advanceTimersByTimeAsync(10_000);

      await rejection;
    });

    it('clears the timeout once a request settles', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok')));

      await apiFetch('/api/business/me');

      expect(vi.getTimerCount()).toBe(0);
    });

    it('recognises only timeout errors', () => {
      expect(isTimeoutError(new DOMException('late', 'TimeoutError'))).toBe(true);
      expect(isTimeoutError(new DOMException('cancelled', 'AbortError'))).toBe(false);
      expect(isTimeoutError(new Error('network down'))).toBe(false);
    });
  });

  describe('security', () => {
    it('does not leak the token into the business id header', () => {
      const secret = 'secret-token-value';
      setAuth({ accessToken: secret, businessId: 'biz-1' });
      const headers = getAuthHeaders();
      expect(headers['x-business-id']).not.toContain(secret);
      expect(headers.Authorization).toBe(`Bearer ${secret}`);
    });
  });
});
