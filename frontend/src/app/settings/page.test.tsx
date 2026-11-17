import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test-utils/render';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeBoundary } from '@/components/theme/theme';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { clearAuth, getAuth, setAuth } from '@/lib/auth-client';
import { businessSettingsCacheKey } from '@/lib/business-settings-cache';

const replaceMock = vi.fn();
const stableRouter = { replace: replaceMock };
vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => stableRouter,
}));

import SettingsPage from './page';

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const businessData = {
  name: 'Maya Traders',
  currency: 'BDT',
  timezone: 'Asia/Dhaka',
  logoUrl: 'https://res.cloudinary.com/demo/logo.png',
  address: {
    street: '123 Main St',
    city: 'Dhaka',
    region: 'Dhaka Division',
    postalCode: '1000',
    country: 'Bangladesh',
  },
  onboardingComplete: true,
};

/** Reads the shared provider so a test can see what the shell badge would show. */
function SettingsProbe() {
  const { currency, timezone } = useBusinessSettings();
  return <p data-testid="shared-settings">{`${currency}|${timezone}`}</p>;
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
  });

  it('shows a loading state before the business profile resolves', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    expect(screen.getByText('Loading...')).toBeVisible();
    // The shell renders while the profile loads, so the page never jumps
    // between a bare screen and the sidebar layout.
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeVisible();
  });

  it('renders inside the app shell with the shared timezone badge', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () => jsonResponse(200, { success: true, data: businessData })),
    );

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByRole('heading', { name: /business profile/i })).toBeVisible();

    const sidebar = screen.getByRole('complementary', { name: /sidebar/i });
    expect(within(sidebar).getByRole('link', { name: /dashboard/i })).toBeVisible();
    expect(await within(sidebar).findByText('Asia/Dhaka · BDT')).toBeVisible();
  });

  it('covers AC-6: describes the timezone field as used for delivery dates and timestamps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: businessData })),
    );

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    const timezone = await screen.findByRole('combobox', { name: /timezone/i });
    expect(timezone).toHaveValue('Asia/Dhaka');
    expect(screen.getByText(/used for delivery dates and timestamps/i)).toBeVisible();
    expect(timezone).toHaveAccessibleDescription(/used for delivery dates and timestamps/i);
  });

  it('covers AC-5: renders the form populated with business data for an OWNER', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: businessData })),
    );

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByRole('heading', { name: /business profile/i })).toBeVisible();
    expect(screen.getByRole('textbox', { name: /business name/i })).toHaveValue('Maya Traders');
    expect(screen.getByLabelText(/currency/i)).toHaveValue('BDT');
    expect(screen.getByRole('textbox', { name: /street/i })).toHaveValue('123 Main St');
    expect(screen.getByRole('textbox', { name: /city/i })).toHaveValue('Dhaka');
    expect(screen.getByRole('combobox', { name: /country/i })).toHaveValue('Bangladesh');
  });

  it('prefills the country from the timezone when the profile has no address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          success: true,
          data: { ...businessData, timezone: 'Europe/Berlin', address: null },
        }),
      ),
    );

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByRole('combobox', { name: /country/i })).toHaveValue('Germany');
  });

  it('shows the logo preview when logoUrl is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: businessData })),
    );

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    const logo = await screen.findByRole('img', { name: /business logo/i });
    expect(logo).toBeVisible();
    expect(logo).toHaveAttribute('src', 'https://res.cloudinary.com/demo/logo.png');
  });

  it('offers a logo upload control instead of a read-only note', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: businessData })),
    );

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    // The old copy told the owner the logo was frozen at onboarding time.
    expect(await screen.findByText(/choose an image to replace/i)).toBeVisible();
    expect(screen.queryByText(/set via the onboarding wizard/i)).not.toBeInTheDocument();
    const input = screen.getByLabelText(/business logo/i);
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
  });

  it('uploads a new logo, updates the preview and the shared settings cache', async () => {
    const nextLogo = 'https://res.cloudinary.com/demo/new-logo.png';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/logo' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: { logoUrl: nextLogo } });
      }
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    // jsdom has no createObjectURL; the preview only needs an opaque string.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-logo');
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    const input = await screen.findByLabelText(/business logo/i);
    const file = new File(['png-bytes'], 'logo.png', { type: 'image/png' });
    await user.upload(input, file);

    // The response URL replaces the local blob preview and the saved message shows.
    expect(await screen.findByRole('status')).toHaveTextContent(/logo updated/i);
    await waitFor(() =>
      expect(screen.getByRole('img', { name: /business logo/i })).toHaveAttribute('src', nextLogo),
    );

    const uploadCall = fetchMock.mock.calls.find((call) => call[0] === '/api/business/logo');
    expect(uploadCall).toBeTruthy();
    const body = uploadCall![1]!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('image')).toBe(file);
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-1'))).toBe(
      JSON.stringify({
        currency: 'BDT',
        timezone: 'Asia/Dhaka',
        name: 'Maya Traders',
        logoUrl: nextLogo,
      }),
    );
  });

  it('shows an error when the business profile cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(500, { message: 'Server error' })),
    );

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/server error/i);
  });

  it('covers AC-5: shows a success message when the OWNER saves the profile', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return jsonResponse(200, { success: true, data: businessData });
      }
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /business profile/i });
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/profile updated/i);
  });

  it('shows the save confirmation as an alert like the other screens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { success: true, data: businessData })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /business profile/i });
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/profile updated/i);
    // Inline, in the page flow, with the shared success signal styling.
    expect(notice.className).not.toMatch(/\bfixed\b/);
    expect(notice.className).toMatch(/\bbg-success-soft\b/);
    expect(notice.className).toMatch(/\btext-success\b/);
  });

  it('closes the save confirmation from its dismiss button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { success: true, data: businessData })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /business profile/i });
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/profile updated/i);

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('covers AC-6: applies the saved timezone when the response omits currency', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        // JSON.stringify drops the undefined currency, so the response has a
        // valid timezone and no currency at all.
        return jsonResponse(200, {
          success: true,
          data: { ...businessData, currency: undefined, timezone: 'Europe/Berlin' },
        });
      }
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
        <SettingsProbe />
      </ThemeBoundary>,
    );

    await screen.findByLabelText(/timezone/i);
    await waitFor(() =>
      expect(screen.getByTestId('shared-settings')).toHaveTextContent('BDT|Asia/Dhaka'),
    );

    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/Berlin');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /change timezone/i }),
    );

    expect(await screen.findByRole('status')).toHaveTextContent(/profile updated/i);
    // The timezone lands even though the currency was missing; the provider
    // keeps the last valid currency instead of dropping the whole update.
    expect(screen.getByTestId('shared-settings')).toHaveTextContent('BDT|Europe/Berlin');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-1'))).toBe(
      JSON.stringify({
        currency: 'BDT',
        timezone: 'Europe/Berlin',
        name: 'Maya Traders',
        logoUrl: 'https://res.cloudinary.com/demo/logo.png',
      }),
    );
  });

  it('covers AC-7: drops the saved settings when the business changes in flight', async () => {
    let resolveSave: (value: Response) => void = () => {};
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      }

      const auth = getAuth();
      const data =
        auth?.businessId === 'biz-2'
          ? { ...businessData, name: 'Other Co', currency: 'EUR', timezone: 'Europe/Paris' }
          : businessData;
      return Promise.resolve(jsonResponse(200, { success: true, data }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
        <SettingsProbe />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /business profile/i });
    await waitFor(() =>
      expect(screen.getByTestId('shared-settings')).toHaveTextContent('BDT|Asia/Dhaka'),
    );

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // The save belongs to biz-1, but the tab signs in as biz-2 before it lands.
    act(() => setAuth({ accessToken: 'tok-2', businessId: 'biz-2' }));
    await waitFor(() =>
      expect(screen.getByTestId('shared-settings')).toHaveTextContent('EUR|Europe/Paris'),
    );

    await act(async () => {
      resolveSave(
        jsonResponse(200, {
          success: true,
          data: { ...businessData, currency: 'USD', timezone: 'America/New_York' },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The response belongs to biz-1, so biz-2 keeps its own settings and cache.
    expect(screen.getByTestId('shared-settings')).toHaveTextContent('EUR|Europe/Paris');
    expect(window.localStorage.getItem(businessSettingsCacheKey('biz-2'))).toBe(
      JSON.stringify({
        currency: 'EUR',
        timezone: 'Europe/Paris',
        name: 'Other Co',
        logoUrl: 'https://res.cloudinary.com/demo/logo.png',
      }),
    );
  });

  it('covers AC-6: shows the stored timezone and its description', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { success: true, data: businessData })),
    );

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByLabelText(/timezone/i)).toHaveValue('Asia/Dhaka');
    expect(screen.getByText(/used for delivery dates and timestamps/i)).toBeVisible();
  });

  it('covers AC-6: persists the fallback when the stored timezone is invalid', async () => {
    const invalidBusiness = { ...businessData, timezone: 'Mars/Olympus' };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return jsonResponse(200, {
          success: true,
          data: { ...businessData, timezone: 'Asia/Dhaka' },
        });
      }
      return jsonResponse(200, { success: true, data: invalidBusiness });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByLabelText(/timezone/i)).toHaveValue('Asia/Dhaka');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // A corrupt stored value uses the fallback as its baseline, so no dialog.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'PUT');
      expect(putCall).toBeTruthy();
      expect(JSON.parse(String(putCall![1]!.body)).timezone).toBe('Asia/Dhaka');
    });
  });

  it('covers AC-6: opens a confirmation dialog before changing the timezone', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return jsonResponse(200, {
          success: true,
          data: { ...businessData, timezone: 'Europe/Berlin' },
        });
      }
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByLabelText(/timezone/i);
    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/Berlin');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/new timezone: europe\/berlin/i)).toBeVisible();
    expect(
      within(dialog).getByText(/existing order dates do not change.*overdue may change/i),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /cancel/i })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /change timezone/i })).toBeEnabled();
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'PUT')).toBe(false);
  });

  it('covers AC-6: cancelling reverts the select and saves nothing', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByLabelText(/timezone/i);
    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/Berlin');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/timezone/i)).toHaveValue('Asia/Dhaka');
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'PUT')).toBe(false);
  });

  it('covers AC-6: confirming sends the new timezone and updates the baseline', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return jsonResponse(200, {
          success: true,
          data: { ...businessData, timezone: 'Europe/Berlin' },
        });
      }
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByLabelText(/timezone/i);
    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/Berlin');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /change timezone/i }),
    );

    expect(await screen.findByRole('status')).toHaveTextContent(/profile updated/i);
    const putCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'PUT');
    expect(JSON.parse(String(putCall![1]!.body)).timezone).toBe('Europe/Berlin');
    expect(screen.getByLabelText(/timezone/i)).toHaveValue('Europe/Berlin');
  });

  it('covers AC-6: closes the confirmation and shows the error when the save fails', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return jsonResponse(400, { error: 'Invalid input', message: 'Timezone update failed' });
      }
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByLabelText(/timezone/i);
    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/Berlin');
    const saveButton = screen.getByRole('button', { name: /save changes/i });
    await user.click(saveButton);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /change timezone/i }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/timezone update failed/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/timezone/i)).toHaveValue('Europe/Berlin');
    const putCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'PUT');
    expect(JSON.parse(String(putCall![1]!.body)).timezone).toBe('Europe/Berlin');
    // covers AC-12: closing the dialog returns focus to the control that opened it
    await waitFor(() => expect(saveButton).toHaveFocus());
  });

  it('covers AC-12: Escape cancels the timezone dialog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        void url;
        void init;
        return jsonResponse(200, { success: true, data: businessData });
      }),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByLabelText(/timezone/i);
    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/Berlin');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(screen.getByRole('dialog')).toBeVisible();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/timezone/i)).toHaveValue('Asia/Dhaka');
  });

  it('covers AC-6: ignores Escape while a confirmed timezone save is running', async () => {
    let resolveSave: (value: Response) => void = () => {};
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: businessData }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByLabelText(/timezone/i);
    const timezone = screen.getByRole('combobox', { name: /timezone/i });
    await user.selectOptions(timezone, 'Europe/Berlin');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /change timezone/i }),
    );

    expect(screen.getByRole('dialog')).toBeVisible();
    expect(timezone).toHaveValue('Europe/Berlin');

    // Escape must not revert the select while the save is still running.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(timezone).toHaveValue('Europe/Berlin');

    await act(async () => {
      resolveSave(jsonResponse(400, { error: 'Invalid input', message: 'Timezone update failed' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/timezone update failed/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(timezone).toHaveValue('Europe/Berlin');
  });

  it('freezes the timezone select while a direct save is in flight', async () => {
    let resolveSave: (value: Response) => void = () => {};
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: businessData }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    const timezone = await screen.findByRole('combobox', { name: /timezone/i });
    // Saving without changing the zone skips the dialog, so this is the path
    // where a new choice could otherwise land while the request is running.
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    expect(timezone).toBeDisabled();

    await act(async () => {
      resolveSave(jsonResponse(200, { success: true, data: businessData }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await screen.findByRole('status')).toHaveTextContent(/profile updated/i);
    expect(timezone).toBeEnabled();
    expect(timezone).toHaveValue('Asia/Dhaka');
  });

  it('rejects a save when the timezone value is invalid', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    const timezone = await screen.findByRole('combobox', { name: /timezone/i });
    // The select never offers an empty option, but a corrupted form value must
    // still block the request instead of saving an invalid zone.
    fireEvent.change(timezone, { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/choose a valid timezone/i);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(0);
  });

  it('covers AC-6: saving an unchanged zone skips the dialog and persists the baseline', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('combobox', { name: /timezone/i });
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // No dialog stands between the click and the request.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(/profile updated/i);

    const putCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    expect(JSON.parse(String(putCalls[0]![1]!.body)).timezone).toBe('Asia/Dhaka');
  });

  it('covers AC-6: an invalid stored zone shows Asia/Dhaka as the baseline and saves without the dialog', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return jsonResponse(200, {
          success: true,
          data: { ...businessData, timezone: 'Asia/Dhaka' },
        });
      }
      // The API returns a corrupt stored value as stored (AC-11).
      return jsonResponse(200, {
        success: true,
        data: { ...businessData, timezone: 'Mars/Olympus' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    const timezone = await screen.findByRole('combobox', { name: /timezone/i });
    expect(timezone).toHaveValue('Asia/Dhaka');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(/profile updated/i);

    const putCalls = fetchMock.mock.calls.filter((call) => call[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(1);
    expect(JSON.parse(String(putCalls[0]![1]!.body)).timezone).toBe('Asia/Dhaka');
  });

  it('covers AC-12: traps Tab inside the timezone dialog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { success: true, data: businessData })),
    );
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByLabelText(/timezone/i);
    await user.selectOptions(screen.getByLabelText(/timezone/i), 'Europe/Berlin');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const dialog = screen.getByRole('dialog');
    const saveButton = screen.getByRole('button', { name: /save changes/i });
    const buttons = within(dialog).getAllByRole('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    // The dialog takes focus first, then Tab moves through its actions in
    // order (close, cancel, confirm) before wrapping back to the first.
    expect(dialog).toHaveFocus();
    for (const button of buttons) {
      await user.tab();
      expect(button).toHaveFocus();
    }
    await user.tab();
    expect(first).toHaveFocus();
    expect(document.activeElement).not.toBe(saveButton);

    // Shift+Tab from the first action wraps to the last.
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('shows an error message when saving fails', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return jsonResponse(400, { error: 'Invalid input', message: 'Name is required' });
      }
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /business profile/i });
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/name is required/i);
  });

  it('disables the save button while a save is in flight', async () => {
    let resolveSave: (value: Response) => void = () => {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/business/me' && init?.method === 'PUT') {
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      }
      return jsonResponse(200, { success: true, data: businessData });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await screen.findByRole('heading', { name: /business profile/i });
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();

    resolveSave(jsonResponse(200, { success: true, data: businessData }));
    await screen.findByRole('status');
  });

  it('redirects unauthenticated visitors to /login', async () => {
    clearAuth();

    render(
      <ThemeBoundary>
        <SettingsPage />
      </ThemeBoundary>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login');
    });
    expect(screen.queryByRole('textbox', { name: /business name/i })).toBeNull();
  });
});
