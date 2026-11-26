import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeBoundary } from '@/components/theme/theme';
import { setAuth } from '@/lib/auth-client';
import { AppShell } from './shell';

// jsdom does not load globals.css, so mirror the app logo rules that decide
// which image is visible. Keep these selectors in sync with globals.css.
const appLogoStyles = document.createElement('style');
appLogoStyles.textContent = `
  .app-logo-dark { display: none; }
  :root[data-theme='dark'] .app-logo-light { display: none; }
  :root[data-theme='dark'] .app-logo-dark { display: block; }
`;
document.head.append(appLogoStyles);

// The shell only reads settings; the provider has its own suite.
const { nav, replaceMock, settings } = vi.hoisted(() => ({
  nav: { pathname: '/dashboard' },
  replaceMock: vi.fn(),
  settings: {
    currency: '',
    timezone: 'Asia/Dhaka',
    name: 'Maya Traders',
    logoUrl: null as string | null,
    mounted: false,
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock('@/components/business/business-settings-provider', () => ({
  useBusinessSettings: () => settings,
}));

function renderShell() {
  return render(
    <ThemeBoundary>
      <AppShell>
        <p>Page content</p>
      </AppShell>
    </ThemeBoundary>,
  );
}

describe('AppShell business day', () => {
  beforeEach(() => {
    window.localStorage.clear();
    replaceMock.mockClear();
    nav.pathname = '/dashboard';
    settings.currency = '';
    settings.timezone = 'Asia/Dhaka';
    settings.name = 'Maya Traders';
    settings.logoUrl = null;
    settings.mounted = false;

    // 20:00 UTC is already the next day in Dhaka, so the browser day and the
    // business day disagree at this instant.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T20:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the light app logo in light mode beside the product name in the sidebar and mobile header', () => {
    const { container } = renderShell();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });

    expect(within(sidebar).getByText('F Commerce')).toBeVisible();
    expect(within(sidebar).getByText('Order Desk')).toBeVisible();

    const lightLogos = Array.from(container.querySelectorAll('img[src="/logo-light.png"]'));
    const darkLogos = Array.from(container.querySelectorAll('img[src="/logo-dark.png"]'));
    expect(lightLogos).toHaveLength(2);
    expect(darkLogos).toHaveLength(2);
    expect(sidebar.querySelector('img[src="/logo-light.png"]')).toBeVisible();
    expect(sidebar.querySelector('img[src="/logo-dark.png"]')).not.toBeVisible();
    for (const logo of lightLogos) expect(logo).toBeVisible();
    for (const logo of darkLogos) expect(logo).not.toBeVisible();
  });

  it('switches the app logo to logo-dark in dark mode and back to logo-light in light mode', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });

    await user.click(within(sidebar).getByRole('button', { name: 'Use dark theme' }));

    for (const logo of container.querySelectorAll('img[src="/logo-dark.png"]')) {
      expect(logo).toBeVisible();
    }
    for (const logo of container.querySelectorAll('img[src="/logo-light.png"]')) {
      expect(logo).not.toBeVisible();
    }

    await user.click(within(sidebar).getByRole('button', { name: 'Use light theme' }));

    for (const logo of container.querySelectorAll('img[src="/logo-light.png"]')) {
      expect(logo).toBeVisible();
    }
    for (const logo of container.querySelectorAll('img[src="/logo-dark.png"]')) {
      expect(logo).not.toBeVisible();
    }
  });

  it('uses logo-dark when the system color scheme changes to dark without a stored override', async () => {
    let matches = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation(() => ({
        get matches() {
          return matches;
        },
        addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      })),
    );

    const { container } = renderShell();
    expect(container.querySelector('img[src="/logo-light.png"]')).toBeVisible();
    expect(container.querySelector('img[src="/logo-dark.png"]')).not.toBeVisible();

    matches = true;
    act(() => {
      for (const listener of listeners) listener();
    });

    await waitFor(() => {
      expect(container.querySelector('img[src="/logo-dark.png"]')).toBeVisible();
      expect(container.querySelector('img[src="/logo-light.png"]')).not.toBeVisible();
    });
  });

  it('shows the uploaded business logo beside the business name', () => {
    settings.logoUrl = 'https://res.cloudinary.com/demo/logo.png';

    renderShell();

    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(sidebar).getByText('Maya Traders')).toBeVisible();
    expect(
      sidebar.querySelector('img[src="https://res.cloudinary.com/demo/logo.png"]'),
    ).not.toBeNull();
  });

  it('shows the business initials when no logo is uploaded', () => {
    renderShell();

    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(sidebar).getByText('MT')).toBeVisible();
  });

  // covers AC-7: the workspace badge names the business zone and currency.
  it('prints the business timezone and currency in the workspace badge', () => {
    settings.currency = 'EUR';
    settings.timezone = 'Europe/Berlin';
    settings.mounted = true;

    renderShell();

    expect(
      within(screen.getByRole('complementary', { name: 'Sidebar' })).getByText(
        'Europe/Berlin · EUR',
      ),
    ).toBeVisible();
  });

  it('shows the workspace badge in the mobile header', () => {
    settings.currency = 'EUR';
    settings.timezone = 'Europe/Berlin';
    settings.mounted = true;

    renderShell();

    expect(within(screen.getByRole('banner')).getByText('Europe/Berlin · EUR')).toBeVisible();
  });

  it('keeps the badge readable when the currency is unknown', () => {
    settings.timezone = 'America/New_York';
    settings.mounted = true;

    renderShell();

    expect(
      within(screen.getByRole('complementary', { name: 'Sidebar' })).getByText('America/New_York'),
    ).toBeVisible();
  });

  // The mobile top row carries the logo, the day, the theme switcher, and the
  // menu button; the menu still reaches Settings and closes.
  it('opens the More sheet from the header menu button and closes it', async () => {
    settings.currency = 'BDT';
    settings.mounted = true;
    const user = userEvent.setup();

    renderShell();

    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: /theme/i })).toBeVisible();

    await user.click(within(header).getByRole('button', { name: /open navigation/i }));

    const sheet = screen.getByRole('dialog', { name: /more/i });
    expect(within(sheet).getByRole('link', { name: /settings/i })).toBeVisible();

    await user.click(within(sheet).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // The deeper team route lives inside settings, so only the team link is current.
  it('marks only the deepest nav match active on a nested page', async () => {
    nav.pathname = '/settings/team';
    const user = userEvent.setup();

    renderShell();

    await user.click(screen.getByRole('button', { name: /open navigation/i }));

    const sheet = screen.getByRole('dialog', { name: /more/i });
    expect(within(sheet).getByRole('link', { name: /team/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(sheet).getByRole('link', { name: /settings/i })).not.toHaveAttribute(
      'aria-current',
    );
  });

  // covers AC-9: the header date follows the business zone, not the browser zone.
  it('shows the business calendar day in the header, not the UTC day', () => {
    settings.timezone = 'Asia/Dhaka';
    settings.mounted = true;

    renderShell();

    const day = screen.getByText('Monday, 26 October');
    expect(day.tagName).toBe('TIME');
    expect(day).toHaveAttribute('dateTime', '2026-10-26');
    expect(screen.queryByText('Sunday, 25 October')).toBeNull();
  });

  // covers AC-7: the day is recomputed at render, so a render after business
  // midnight shows the new day without waiting for a timer.
  it('shows the next business day on the next render after midnight', () => {
    settings.timezone = 'Asia/Dhaka';
    settings.mounted = true;

    const { rerender } = renderShell();
    expect(screen.getByText('Monday, 26 October')).toBeVisible();

    vi.setSystemTime(new Date('2026-10-26T20:00:00.000Z'));
    rerender(
      <ThemeBoundary>
        <AppShell>
          <p>Page content</p>
        </AppShell>
      </ThemeBoundary>,
    );

    const day = screen.getByText('Tuesday, 27 October');
    expect(day).toHaveAttribute('dateTime', '2026-10-27');
    expect(screen.queryByText('Monday, 26 October')).toBeNull();
  });

  // covers AC-9: the day waits for the client clock instead of guessing.
  it('shows no day until the client clock is known', () => {
    const { container } = renderShell();

    expect(container.querySelector('time')).toBeNull();
    expect(
      within(screen.getByRole('complementary', { name: 'Sidebar' })).getByText('Asia/Dhaka'),
    ).toBeVisible();
  });

  it('logs out from the sidebar and returns to sign in', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });

    renderShell();

    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    await user.click(within(sidebar).getByRole('button', { name: /log out/i }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(window.localStorage.getItem('accessToken')).toBeNull();
    expect(window.localStorage.getItem('businessId')).toBeNull();
  });

  it('offers log out from the More sheet on mobile', async () => {
    const user = userEvent.setup();

    renderShell();

    await user.click(screen.getByRole('button', { name: /open navigation/i }));

    expect(
      within(screen.getByRole('dialog', { name: /more/i })).getByRole('button', {
        name: /log out/i,
      }),
    ).toBeVisible();
  });

  // covers AC-21: Payments appears in desktop sidebar and mobile More sheet while bottom nav stays 5 slots.
  it('places Payments in the desktop sidebar and mobile More sheet while keeping the bottom bar at 5 slots', async () => {
    const user = userEvent.setup();
    renderShell();

    const sidebarNav = within(screen.getByRole('complementary', { name: 'Sidebar' })).getByRole(
      'navigation',
      { name: 'Primary navigation' },
    );
    expect(within(sidebarNav).getByRole('link', { name: 'Payments' })).toHaveAttribute(
      'href',
      '/payments',
    );

    const mobileNav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const mobileLinks = within(mobileNav).getAllByRole('link');
    const mobileButtons = within(mobileNav).getAllByRole('button');
    expect(mobileLinks.length + mobileButtons.length).toBe(5);
    expect(within(mobileNav).queryByRole('link', { name: 'Payments' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /open navigation/i }));
    const sheet = screen.getByRole('dialog', { name: /more/i });
    expect(within(sheet).getByRole('link', { name: 'Payments' })).toHaveAttribute(
      'href',
      '/payments',
    );
  });
});
