import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuth, setAuth } from '@/lib/auth-client';
import {
  businessSettingsCacheKey,
  writeBusinessSettingsCache,
} from '@/lib/business-settings-cache';
import { BusinessSettingsProvider, useBusinessSettings } from './business-settings-provider';

function Consumer() {
  const { currency, timezone, mounted } = useBusinessSettings();
  return <p data-testid="settings">{`${currency}|${timezone}|${mounted}`}</p>;
}

function IdentityConsumer() {
  const { name, logoUrl } = useBusinessSettings();
  return <p data-testid="identity">{`${name}|${logoUrl ?? ''}`}</p>;
}

function SettingsWriter({
  next,
  businessId,
}: {
  next: { currency: string; timezone: string };
  businessId: string;
}) {
  const { updateSettings } = useBusinessSettings();
  return (
    <button type="button" onClick={() => updateSettings(next, businessId)}>
      write settings
    </button>
  );
}

function renderProvider() {
  return render(
    <BusinessSettingsProvider>
      <Consumer />
    </BusinessSettingsProvider>,
  );
}

function profileResponse(
  currency: string,
  timezone: string,
  name = 'Maya Traders',
  logoUrl: string | null = null,
): Response {
  return {
    ok: true,
    json: async () => ({ success: true, data: { name, logoUrl, currency, timezone } }),
  } as Response;
}

/** Let the provider's fetch promise chain settle inside act. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('BusinessSettingsProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuth();
  });

  it('uses the fallback without auth and does not fetch', () => {
    renderProvider();

    expect(screen.getByTestId('settings')).toHaveTextContent('|Asia/Dhaka|true');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies a cached entry before the profile request resolves', () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-cache' });
    writeBusinessSettingsCache('biz-cache', { currency: 'USD', timezone: 'Europe/Berlin' });

    renderProvider();

    expect(screen.getByTestId('settings')).toHaveTextContent('USD|Europe/Berlin|true');
  });

  it('loads the profile once and writes the cache', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-fetch' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => profileResponse('EUR', 'Europe/Paris')),
    );

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId('settings')).toHaveTextContent('EUR|Europe/Paris|true'),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-fetch'))).toBe(
      JSON.stringify({
        currency: 'EUR',
        timezone: 'Europe/Paris',
        name: 'Maya Traders',
        logoUrl: null,
      }),
    );
  });

  it('loads the business name and logo for the sidebar', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-identity' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        profileResponse(
          'USD',
          'America/New_York',
          'Acme Supply',
          'https://res.cloudinary.com/demo/logo.png',
        ),
      ),
    );

    render(
      <BusinessSettingsProvider>
        <IdentityConsumer />
      </BusinessSettingsProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('identity')).toHaveTextContent(
        'Acme Supply|https://res.cloudinary.com/demo/logo.png',
      ),
    );
  });

  it('keeps the cache when the profile request fails', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-fail' });
    writeBusinessSettingsCache('biz-fail', { currency: 'GBP', timezone: 'Europe/London' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false }) as Response),
    );

    renderProvider();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('settings')).toHaveTextContent('GBP|Europe/London|true');
  });

  it('removes a malformed cache entry and uses the fallback', () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-bad-cache' });
    window.localStorage.setItem(
      businessSettingsCacheKey('biz-bad-cache'),
      JSON.stringify({ currency: 'BDT', timezone: 'Mars/Olympus' }),
    );

    renderProvider();

    expect(screen.getByTestId('settings')).toHaveTextContent('|Asia/Dhaka|true');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-bad-cache'))).toBeNull();
  });

  it('falls back to Asia/Dhaka when the profile timezone is invalid', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-bad-profile' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => profileResponse('BDT', 'Mars/Olympus')),
    );

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId('settings')).toHaveTextContent('BDT|Asia/Dhaka|true'),
    );
  });

  it('clears to the fallback and removes the cache on sign out', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-signout' });
    writeBusinessSettingsCache('biz-signout', { currency: 'USD', timezone: 'America/New_York' });

    renderProvider();
    expect(screen.getByTestId('settings')).toHaveTextContent('USD|America/New_York|true');

    act(() => clearAuth());

    expect(screen.getByTestId('settings')).toHaveTextContent('|Asia/Dhaka|true');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-signout'))).toBeNull();
  });

  it('loads a business after setAuth without remounting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => profileResponse('USD', 'America/Chicago')),
    );

    renderProvider();
    expect(screen.getByTestId('settings')).toHaveTextContent('|Asia/Dhaka|true');

    act(() => setAuth({ accessToken: 'tok', businessId: 'biz-late' }));

    await waitFor(() =>
      expect(screen.getByTestId('settings')).toHaveTextContent('USD|America/Chicago|true'),
    );
  });

  it('never reads another business cache', () => {
    writeBusinessSettingsCache('biz-other', { currency: 'EUR', timezone: 'Europe/Paris' });
    setAuth({ accessToken: 'tok', businessId: 'biz-mine' });

    renderProvider();

    expect(screen.getByTestId('settings')).toHaveTextContent('|Asia/Dhaka|true');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-other'))).not.toBeNull();
  });

  it('keeps the last valid currency when a caller writes an invalid one', () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-bad-write' });
    writeBusinessSettingsCache('biz-bad-write', { currency: 'USD', timezone: 'Europe/Berlin' });

    render(
      <BusinessSettingsProvider>
        <Consumer />
        <SettingsWriter
          next={{ currency: '', timezone: 'America/New_York' }}
          businessId="biz-bad-write"
        />
      </BusinessSettingsProvider>,
    );

    act(() => {
      screen.getByRole('button', { name: /write settings/i }).click();
    });

    // The bad currency is ignored, and the valid zone from the same write lands.
    expect(screen.getByTestId('settings')).toHaveTextContent('USD|America/New_York|true');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-bad-write'))).toBe(
      JSON.stringify({
        currency: 'USD',
        timezone: 'America/New_York',
        name: '',
        logoUrl: null,
      }),
    );
  });

  it('keeps the last valid timezone when a caller writes an invalid one', () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-bad-zone-write' });
    writeBusinessSettingsCache('biz-bad-zone-write', {
      currency: 'USD',
      timezone: 'Europe/Berlin',
    });

    render(
      <BusinessSettingsProvider>
        <Consumer />
        <SettingsWriter
          next={{ currency: 'EUR', timezone: 'Mars/Olympus' }}
          businessId="biz-bad-zone-write"
        />
      </BusinessSettingsProvider>,
    );

    act(() => {
      screen.getByRole('button', { name: /write settings/i }).click();
    });

    // The valid currency lands and the bad zone leaves the cached zone intact.
    expect(screen.getByTestId('settings')).toHaveTextContent('EUR|Europe/Berlin|true');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-bad-zone-write'))).toBe(
      JSON.stringify({
        currency: 'EUR',
        timezone: 'Europe/Berlin',
        name: '',
        logoUrl: null,
      }),
    );
  });

  it('writes both fields and the cache when a caller sends a valid pair', () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-good-write' });
    writeBusinessSettingsCache('biz-good-write', { currency: 'USD', timezone: 'Europe/Berlin' });

    render(
      <BusinessSettingsProvider>
        <Consumer />
        <SettingsWriter
          next={{ currency: 'GBP', timezone: 'America/New_York' }}
          businessId="biz-good-write"
        />
      </BusinessSettingsProvider>,
    );

    act(() => {
      screen.getByRole('button', { name: /write settings/i }).click();
    });

    expect(screen.getByTestId('settings')).toHaveTextContent('GBP|America/New_York|true');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-good-write'))).toBe(
      JSON.stringify({
        currency: 'GBP',
        timezone: 'America/New_York',
        name: '',
        logoUrl: null,
      }),
    );
  });

  it('drops a save that lands after the active business changed', () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-save-a' });
    writeBusinessSettingsCache('biz-save-a', { currency: 'USD', timezone: 'Europe/Berlin' });
    writeBusinessSettingsCache('biz-save-b', { currency: 'EUR', timezone: 'Europe/Paris' });

    render(
      <BusinessSettingsProvider>
        <Consumer />
        <SettingsWriter
          next={{ currency: 'GBP', timezone: 'America/New_York' }}
          businessId="biz-save-a"
        />
      </BusinessSettingsProvider>,
    );

    act(() => setAuth({ accessToken: 'tok', businessId: 'biz-save-b' }));

    expect(screen.getByTestId('settings')).toHaveTextContent('EUR|Europe/Paris|true');

    act(() => {
      screen.getByRole('button', { name: /write settings/i }).click();
    });

    // The save belonged to biz-save-a, so it must not touch biz-save-b or its cache.
    expect(screen.getByTestId('settings')).toHaveTextContent('EUR|Europe/Paris|true');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-save-a'))).toBe(
      JSON.stringify({ currency: 'USD', timezone: 'Europe/Berlin' }),
    );
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-save-b'))).toBe(
      JSON.stringify({ currency: 'EUR', timezone: 'Europe/Paris' }),
    );
  });

  it('ignores a settings write when there is no active business', () => {
    render(
      <BusinessSettingsProvider>
        <Consumer />
        <SettingsWriter
          next={{ currency: 'USD', timezone: 'America/New_York' }}
          businessId="biz-none"
        />
      </BusinessSettingsProvider>,
    );

    act(() => {
      screen.getByRole('button', { name: /write settings/i }).click();
    });

    expect(screen.getByTestId('settings')).toHaveTextContent('|Asia/Dhaka|true');
    expect(window.localStorage.length).toBe(0);
  });

  it('refetches when the token changes for the same business', async () => {
    setAuth({ accessToken: 'tok-1', businessId: 'biz-token' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(profileResponse('USD', 'America/Chicago'))
      .mockResolvedValueOnce(profileResponse('EUR', 'Europe/Paris'));
    vi.stubGlobal('fetch', fetchMock);

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId('settings')).toHaveTextContent('USD|America/Chicago|true'),
    );

    act(() => setAuth({ accessToken: 'tok-2', businessId: 'biz-token' }));

    await waitFor(() =>
      expect(screen.getByTestId('settings')).toHaveTextContent('EUR|Europe/Paris|true'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('makes one profile request when the business changes', async () => {
    setAuth({ accessToken: 'tok-a', businessId: 'biz-switch-a' });
    const fetchMock = vi.fn(async () => profileResponse('EUR', 'Europe/Paris'));
    fetchMock.mockResolvedValueOnce(profileResponse('USD', 'America/Chicago'));
    vi.stubGlobal('fetch', fetchMock);

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId('settings')).toHaveTextContent('USD|America/Chicago|true'),
    );

    act(() => setAuth({ accessToken: 'tok-b', businessId: 'biz-switch-b' }));

    await waitFor(() =>
      expect(screen.getByTestId('settings')).toHaveTextContent('EUR|Europe/Paris|true'),
    );
    // One request on mount and one for the new business. The old effect's
    // listener must not send a duplicate before its cleanup runs.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the cache when the profile request rejects', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-rejected' });
    writeBusinessSettingsCache('biz-rejected', { currency: 'GBP', timezone: 'Europe/London' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );

    renderProvider();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await flush();

    expect(screen.getByTestId('settings')).toHaveTextContent('GBP|Europe/London|true');
  });

  it('drops a profile response that resolves after sign out', async () => {
    setAuth({ accessToken: 'tok', businessId: 'biz-late-signout' });
    let resolveFetch: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    renderProvider();
    expect(screen.getByTestId('settings')).toHaveTextContent('|Asia/Dhaka|true');

    act(() => clearAuth());

    await act(async () => {
      resolveFetch(profileResponse('USD', 'America/New_York'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByTestId('settings')).toHaveTextContent('|Asia/Dhaka|true');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-late-signout'))).toBeNull();
  });
});
