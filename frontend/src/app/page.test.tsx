import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test-utils/render';
import userEvent from '@testing-library/user-event';
import { ThemeBoundary } from '@/components/theme/theme';
import Home from './page';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ replace: vi.fn() }),
}));

describe('seller console foundation', () => {
  function renderPage() {
    return render(
      <ThemeBoundary>
        <Home />
      </ThemeBoundary>,
    );
  }

  it('renders the dashboard and primary navigation', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: /keep today moving/i })).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Orders' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Orders' })[0]).toHaveAttribute('href', '/orders');
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
    expect(screen.getByText('Recent orders')).toBeVisible();
  });

  it('provides a labeled theme toggle', async () => {
    const user = userEvent.setup();
    renderPage();

    const toggle = screen.getAllByRole('button', { name: 'Use dark theme' })[0];
    expect(toggle).toBeVisible();

    await user.click(toggle);

    expect(screen.getAllByRole('button', { name: 'Use light theme' })[0]).toBeVisible();
  });
});
