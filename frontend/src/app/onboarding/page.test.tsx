import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test-utils/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeBoundary } from '@/components/theme/theme';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { setAuth } from '@/lib/auth-client';
import { businessSettingsCacheKey } from '@/lib/business-settings-cache';

const replaceMock = vi.fn();
// a stable router object, so the page's [router]-dependent effect does not re-run on every render
const stableRouter = { replace: replaceMock };
vi.mock('next/navigation', () => ({
  usePathname: () => '/onboarding',
  useRouter: () => stableRouter,
}));

import OnboardingPage from './page';

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const incompleteBusiness = {
  name: 'Maya Traders',
  currency: 'BDT',
  timezone: 'Asia/Dhaka',
  logoUrl: null,
  address: null,
  onboardingComplete: false,
};

/** Reads the shared provider so a test can see what the shell badge would show. */
function SettingsProbe() {
  const { currency, timezone } = useBusinessSettings();
  return <p data-testid="settings">{`${currency}|${timezone}`}</p>;
}

// jsdom does not implement URL.createObjectURL, used for the logo preview
function setupObjectUrl() {
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      value: (file: File) => `blob:mock-${file.name}`,
      configurable: true,
    });
  }
}

// `browserTimeZone` asks the runtime for the browser zone with no arguments.
// Keep the real constructor for every call that passes a locale or options, so
// schema validation still uses the runtime's own timezone data.
function stubBrowserTimeZone(zone: string) {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
    locale?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    if (locale === undefined && options === undefined) {
      return { resolvedOptions: () => ({ timeZone: zone }) } as Intl.DateTimeFormat;
    }
    return new RealDateTimeFormat(locale, options);
  } as typeof Intl.DateTimeFormat);
}

describe('OnboardingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    // OnboardingPage now guards on auth before fetching; seed a session so
    // the wizard-based tests render past the guard.
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
    setupObjectUrl();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shows a loading state before the business profile resolves', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () => new Promise(() => {}), // never settles
      ),
    );

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    expect(screen.getByText(/loading your profile/i)).toHaveClass('sr-only');
  });

  it('shows an error when the business profile cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    // the load failure shows a banner
    const alert = await screen.findByRole('alert');
    expect(/failed to load business/i.test(alert.textContent ?? '')).toBe(true);
  });

  it('covers AC-1: renders the wizard on step one for an incomplete business', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: incompleteBusiness })),
    );

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByRole('heading', { name: /welcome/i })).toBeVisible();
    expect(screen.getByText('Step 1 of 4')).toBeVisible();
    expect(screen.getByRole('button', { name: /get started/i })).toBeEnabled();
  });

  it('proceeds from step one to step two when Get started is clicked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: incompleteBusiness })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    expect(screen.getByText('Step 2 of 4')).toBeVisible();
  });

  it('walks back and forth through the address step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: incompleteBusiness })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    // now on step 2; Back returns to step 1
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByText('Step 1 of 4')).toBeVisible();
  });

  it('prefills the country from the browser timezone instead of a fixed value', async () => {
    stubBrowserTimeZone('Europe/Berlin');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: incompleteBusiness })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));

    const country = screen.getByRole('combobox', { name: /country/i });
    expect(country).toHaveValue('Germany');
    expect(within(country).getByRole('option', { name: 'Canada' })).toBeInTheDocument();
    expect(within(country).getByRole('option', { name: 'United States' })).toBeInTheDocument();
  });

  it('prefills the country from a draft timezone when the draft has no address yet', async () => {
    const withDraft = {
      ...incompleteBusiness,
      onboardingDraft: {
        currency: 'EUR',
        timezone: 'Europe/Berlin',
        logoUrl: '',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: withDraft })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));

    expect(screen.getByRole('combobox', { name: /country/i })).toHaveValue('Germany');
  });

  it('keeps a saved draft country when one was chosen', async () => {
    stubBrowserTimeZone('Europe/Berlin');
    const withDraft = {
      ...incompleteBusiness,
      onboardingDraft: {
        currency: 'USD',
        timezone: 'Europe/Berlin',
        address: { street: '9 Draft St', city: 'Chittagong', country: 'Bangladesh' },
        logoUrl: '',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: withDraft })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));

    expect(screen.getByRole('combobox', { name: /country/i })).toHaveValue('Bangladesh');
  });

  it('covers AC-1: restores a saved draft when the profile has one', async () => {
    const withDraft = {
      ...incompleteBusiness,
      onboardingDraft: {
        name: 'Draft Biz',
        currency: 'USD',
        address: { street: '9 Draft St', city: 'Chittagong', country: 'Bangladesh' },
        logoUrl: '',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: withDraft })),
    );

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    // Step 1 should show the business name from the profile (not the draft name)
    const greeting = await screen.findByText(/maya traders/i);
    expect(greeting).toBeVisible();
  });

  it('covers AC-5: restores a valid draft timezone on step three', async () => {
    const withDraft = {
      ...incompleteBusiness,
      onboardingDraft: {
        name: 'Draft Biz',
        currency: 'USD',
        timezone: 'Europe/Berlin',
        address: { street: '9 Draft St', city: 'Chittagong', country: 'Bangladesh' },
        logoUrl: '',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: withDraft })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.getByLabelText(/timezone/i)).toHaveValue('Europe/Berlin');
  });

  it('covers AC-5: prefills the browser timezone when there is no draft', async () => {
    stubBrowserTimeZone('Europe/Berlin');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: incompleteBusiness })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.getByLabelText(/timezone/i)).toHaveValue('Europe/Berlin');
  });

  it('covers AC-5: ignores an invalid draft timezone and keeps the browser prefill', async () => {
    stubBrowserTimeZone('Europe/Berlin');
    const withDraft = {
      ...incompleteBusiness,
      onboardingDraft: {
        name: 'Draft Biz',
        currency: 'USD',
        timezone: 'Mars/Olympus',
        address: { street: '9 Draft St', city: 'Chittagong', country: 'Bangladesh' },
        logoUrl: '',
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: withDraft })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.getByLabelText(/timezone/i)).toHaveValue('Europe/Berlin');
  });

  it('covers AC-5: describes the timezone field as used for delivery deadlines and timestamps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: incompleteBusiness })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    const timezone = screen.getByRole('combobox', { name: /timezone/i });
    expect(timezone).toHaveAccessibleDescription(/used for delivery deadlines and timestamps/i);
  });

  it('covers AC-5: saves a changed timezone as a draft', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding/draft' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse(200, { success: true, message: 'Draft saved' }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: incompleteBusiness }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/London');

    await waitFor(
      () => {
        const draftCall = fetchMock.mock.calls.find(
          (call) => call[0] === '/api/business/onboarding/draft' && call[1]?.method === 'PUT',
        );
        expect(draftCall).toBeTruthy();
      },
      { timeout: 2000 },
    );

    const draftCall = fetchMock.mock.calls.find(
      (call) => call[0] === '/api/business/onboarding/draft' && call[1]?.method === 'PUT',
    );
    const draftBody = JSON.parse(String(draftCall![1]!.body));
    expect(draftBody.field).toBe('timezone');
    expect(draftBody.value).toBe('Europe/London');
  });

  it('covers AC-5: keeps the timezone draft when currency changes inside the debounce window', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding/draft' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse(200, { success: true, message: 'Draft saved' }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: incompleteBusiness }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    // Fake only the draft debounce. fireEvent keeps both changes synchronous,
    // so timezone and currency land inside the same 500ms window.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(screen.getByLabelText(/timezone/i), {
      target: { value: 'Europe/Berlin' },
    });
    fireEvent.change(screen.getByLabelText(/currency/i), {
      target: { value: 'EUR' },
    });

    await vi.advanceTimersByTimeAsync(600);

    const draftBodies = fetchMock.mock.calls
      .filter((call) => call[0] === '/api/business/onboarding/draft' && call[1]?.method === 'PUT')
      .map((call) => JSON.parse(String(call[1]!.body)));

    expect(draftBodies).toHaveLength(2);
    expect(draftBodies).toEqual(
      expect.arrayContaining([
        { field: 'timezone', value: 'Europe/Berlin' },
        { field: 'currency', value: 'EUR' },
      ]),
    );
  });

  it('covers AC-5: lets a later business save the same draft timezone after unmount', async () => {
    stubBrowserTimeZone('Asia/Dhaka');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding/draft' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse(200, { success: true, message: 'Draft saved' }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: incompleteBusiness }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const draftCalls = () =>
      fetchMock.mock.calls.filter(
        (call) => call[0] === '/api/business/onboarding/draft' && call[1]?.method === 'PUT',
      );
    const user = userEvent.setup();

    const first = render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/London');

    await waitFor(() => expect(draftCalls()).toHaveLength(1), { timeout: 2000 });

    // Sign out and sign in as a fresh business in the same tab.
    first.unmount();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/London');

    // The second business has no draft, so the shared cache must not skip this save.
    await waitFor(() => expect(draftCalls()).toHaveLength(2), { timeout: 2000 });
    expect(JSON.parse(String(draftCalls()[1]![1]!.body)).value).toBe('Europe/London');
  });

  it('covers AC-5: shows the timezone on review and sends it with completion', async () => {
    const withDraft = {
      ...incompleteBusiness,
      onboardingDraft: {
        name: 'Draft Biz',
        currency: 'USD',
        timezone: 'Europe/Berlin',
        address: { street: '9 Draft St', city: 'Chittagong', country: 'Bangladesh' },
        logoUrl: '',
      },
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding' && init?.method === 'PUT') {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: {
              name: 'Maya Traders',
              currency: 'USD',
              timezone: 'Europe/Berlin',
              onboardingComplete: true,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: withDraft }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.getByText(/Europe\/Berlin/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: /enter order desk/i }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
    const onboardingCall = fetchMock.mock.calls.find(
      (call) => call[0] === '/api/business/onboarding' && call[1]?.method === 'PUT',
    );
    expect(JSON.parse(String(onboardingCall![1]!.body)).timezone).toBe('Europe/Berlin');
  });

  it('covers AC-5: updates the shared settings from the completion response', async () => {
    const withDraft = {
      ...incompleteBusiness,
      onboardingDraft: {
        name: 'Draft Biz',
        currency: 'USD',
        timezone: 'Europe/London',
        address: { street: '9 Draft St', city: 'Chittagong', country: 'Bangladesh' },
        logoUrl: '',
      },
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding' && init?.method === 'PUT') {
        // The response carries a zone the form never held, so the assertion
        // proves the page reads the response body instead of its own state.
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: {
              name: 'Maya Traders',
              currency: 'USD',
              timezone: 'America/New_York',
              onboardingComplete: true,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: withDraft }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
        <SettingsProbe />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    // The provider paints the stored profile before the wizard finishes.
    await waitFor(() => expect(screen.getByTestId('settings')).toHaveTextContent('BDT|Asia/Dhaka'));

    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /enter order desk/i }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
    // The completion response, not the draft zone, is what the badge now shows.
    expect(screen.getByTestId('settings')).toHaveTextContent('USD|America/New_York');
  });

  it('covers AC-5: applies the completion timezone when the response omits currency', async () => {
    const withDraft = {
      ...incompleteBusiness,
      onboardingDraft: {
        name: 'Draft Biz',
        currency: 'USD',
        timezone: 'Europe/London',
        address: { street: '9 Draft St', city: 'Chittagong', country: 'Bangladesh' },
        logoUrl: '',
      },
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding' && init?.method === 'PUT') {
        // JSON.stringify drops the undefined currency, so only the timezone
        // is present in the completion response.
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: {
              name: 'Maya Traders',
              currency: undefined,
              timezone: 'America/New_York',
              onboardingComplete: true,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: withDraft }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
        <SettingsProbe />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await waitFor(() => expect(screen.getByTestId('settings')).toHaveTextContent('BDT|Asia/Dhaka'));

    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /enter order desk/i }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
    // The missing currency keeps the stored value; the valid timezone lands.
    expect(screen.getByTestId('settings')).toHaveTextContent('BDT|America/New_York');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-1'))).toBe(
      JSON.stringify({
        currency: 'BDT',
        timezone: 'America/New_York',
        name: 'Maya Traders',
        logoUrl: null,
      }),
    );
  });

  it('covers AC-5: blocks step three with an inline error for an invalid timezone', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding/draft' && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse(200, { success: true, message: 'Draft saved' }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: incompleteBusiness }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(screen.getByText('Step 3 of 4')).toBeVisible();

    // The select never offers an empty option, but a corrupted form value must
    // still block the wizard with the message the spec requires.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(screen.getByLabelText(/timezone/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(screen.getByText(/choose a valid timezone/i)).toBeVisible();
    expect(screen.getByText('Step 3 of 4')).toBeVisible();

    // Flush the debounced draft write so it cannot leak into the next test.
    await vi.advanceTimersByTimeAsync(600);
  });

  it('covers AC-7: drops the completion settings when the business changes in flight', async () => {
    let resolveCompletion: (value: Response) => void = () => {};
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding' && init?.method === 'PUT') {
        return new Promise<Response>((resolve) => {
          resolveCompletion = resolve;
        });
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: incompleteBusiness }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
        <SettingsProbe />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /enter order desk/i }));

    // The save belongs to biz-1, but the tab signs in as biz-2 before it lands.
    act(() => setAuth({ accessToken: 'tok-2', businessId: 'biz-2' }));
    await waitFor(() => expect(screen.getByTestId('settings')).toHaveTextContent('BDT|Asia/Dhaka'));

    await act(async () => {
      resolveCompletion(
        jsonResponse(200, {
          success: true,
          data: {
            ...incompleteBusiness,
            currency: 'EUR',
            timezone: 'Europe/Berlin',
            onboardingComplete: true,
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The response belongs to biz-1, so biz-2 keeps its own settings and cache.
    expect(screen.getByTestId('settings')).toHaveTextContent('BDT|Asia/Dhaka');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-2'))).toBe(
      JSON.stringify({
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        name: 'Maya Traders',
        logoUrl: null,
      }),
    );
  });

  it('covers AC-5: cancels a pending draft save when onboarding completes', async () => {
    const withDraft = {
      ...incompleteBusiness,
      onboardingDraft: {
        name: 'Draft Biz',
        currency: 'USD',
        timezone: 'Europe/Berlin',
        address: { street: '9 Draft St', city: 'Chittagong', country: 'Bangladesh' },
        logoUrl: '',
      },
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding' && init?.method === 'PUT') {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: {
              name: 'Maya Traders',
              currency: 'USD',
              timezone: 'Europe/London',
              onboardingComplete: true,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: withDraft }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const realUser = userEvent.setup();
    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await realUser.click(screen.getByRole('button', { name: /get started/i }));
    await realUser.click(screen.getByRole('button', { name: /^continue$/i }));

    // Fake only the draft debounce. fireEvent keeps the interaction synchronous,
    // so userEvent's internal waits cannot stall on the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.change(screen.getByLabelText(/timezone/i), {
      target: { value: 'Europe/London' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(screen.getByRole('button', { name: /enter order desk/i }));

    await vi.advanceTimersByTimeAsync(100);
    expect(replaceMock).toHaveBeenCalledWith('/dashboard');

    await vi.advanceTimersByTimeAsync(600);
    const draftCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === '/api/business/onboarding/draft' && call[1]?.method === 'PUT',
    );
    expect(draftCalls).toHaveLength(0);
  });

  it('pre-fills business name from onboarding endpoint when business/me returns 403', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void init;
      if (url === '/api/business/onboarding') {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: { name: 'Registered Biz Name', onboardingDraft: null },
            message: 'Onboarding retrieved',
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(403, {
          error: 'Onboarding required',
          message: 'Please complete your business profile before accessing this resource',
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    setAuth({ accessToken: 'tok', businessId: 'b1' });

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    // Step 1 should show the business name from the auth profile
    const greeting = await screen.findByText(/registered biz name/i);
    expect(greeting).toBeVisible();
    // Get started button should be enabled because the name is pre-filled
    expect(screen.getByRole('button', { name: /get started/i })).toBeEnabled();
  });

  it('does not treat a different 403 error as the onboarding gate', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/business/onboarding') {
        return Promise.resolve(jsonResponse(200, { success: true, data: incompleteBusiness }));
      }
      return Promise.resolve(
        jsonResponse(403, {
          error: 'Forbidden',
          message: 'Onboarding is not available for this account',
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText(/access denied/i)).toBeVisible();
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/business/onboarding')).toBe(false);
  });

  it('covers AC-3: rejects a non-image file upload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: incompleteBusiness })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    // now on step 3
    const input = document.getElementById('logo-upload') as HTMLInputElement;
    const textFile = new File(['not an image'], 'notes.txt', { type: 'text/plain' });
    // jsdom file inputs don't retain File type reliably, so drive the handler directly
    const changeEvent = new Event('change', { bubbles: true });
    Object.defineProperty(input, 'files', { value: [textFile], configurable: true });
    input.dispatchEvent(changeEvent);

    await screen.findByText(/only image files are allowed/i);
  });

  it('covers AC-3: uploads an image and shows a preview', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: incompleteBusiness }))
      .mockResolvedValueOnce(
        jsonResponse(200, { success: true, data: { logoUrl: 'https://cdn/logo.png' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    const input = document.getElementById('logo-upload') as HTMLInputElement;
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', {
      type: 'image/png',
    });
    Object.defineProperty(input, 'files', { value: [png], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // a successful upload POSTs to the logo endpoint and shows the preview img
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => c[0] === '/api/business/logo')).toBe(true);
    });
    expect(screen.getByRole('img', { name: /logo preview/i })).toBeVisible();
  });

  it('covers AC-4: completes onboarding and redirects to the dashboard', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/onboarding' && init?.method === 'PUT') {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: {
              name: 'Maya Traders',
              currency: 'BDT',
              timezone: 'Asia/Dhaka',
              onboardingComplete: true,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: incompleteBusiness }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    // walk to the review step, awaiting each transition
    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    const finishBtn = screen.getByRole('button', { name: /enter order desk/i });
    expect(finishBtn).toBeEnabled();
    await user.click(finishBtn);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/dashboard'));
    const onboardingCall = fetchMock.mock.calls.find((c) => c[0] === '/api/business/onboarding');
    expect(onboardingCall).toBeDefined();
    expect(onboardingCall?.[1]?.method).toBe('PUT');
  });

  it('displays business name on step 1 without an editable field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: incompleteBusiness })),
    );

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    // The business name should appear in the welcome text, not as an input
    await screen.findByText(/maya traders/i);
    expect(screen.queryByRole('textbox', { name: /business name/i })).toBeNull();
  });

  it('saves draft when user enters address in step 2', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { success: true, data: incompleteBusiness }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    // Navigate to step 2
    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));

    // Type in address field
    const streetField = await screen.findByLabelText('Street');
    await user.type(streetField, '123 New St');

    // Wait for debounced draft save (500ms debounce, needs longer waitFor timeout)
    await waitFor(
      () => {
        const draftCall = fetchMock.mock.calls.find(
          (call) => call[0] === '/api/business/onboarding/draft' && call[1]?.method === 'PUT',
        );
        expect(draftCall).toBeTruthy();
      },
      { timeout: 2000 },
    );

    // Verify the draft save payload includes the address
    const draftCall = fetchMock.mock.calls.find(
      (call) => call[0] === '/api/business/onboarding/draft' && call[1]?.method === 'PUT',
    );
    const draftBody = JSON.parse(String(draftCall![1]!.body));
    expect(draftBody.field).toBe('address');
    expect(draftBody.value.street).toBe('123 New St');
  });

  it('shows an error when onboarding completion fails', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/business/onboarding') {
        return Promise.resolve(jsonResponse(400, { message: 'Validation failed' }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: incompleteBusiness }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /welcome/i });
    await user.click(screen.getByRole('button', { name: /get started/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /^continue$/i }));
    await user.click(screen.getByRole('button', { name: /enter order desk/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/validation failed/i);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('shows the business name in the welcome greeting on step 1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          success: true,
          data: { ...incompleteBusiness, name: 'Unique Shop' },
        }),
      ),
    );

    render(
      <ThemeBoundary>
        <OnboardingPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByRole('heading', { name: 'Welcome, Unique Shop!' })).toBeVisible();
  });
});
