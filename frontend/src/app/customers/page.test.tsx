import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test-utils/render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerDto } from '@f-commerce/contracts';

import { ThemeBoundary } from '@/components/theme/theme';
import { setAuth } from '@/lib/auth-client';

const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/customers',
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useParams: () => ({ id: 'customer-1' }),
}));

import CustomersPage from './page';

function makeCustomer(overrides: Partial<CustomerDto> = {}): CustomerDto {
  return {
    id: 'customer-1',
    name: 'Nusrat Jahan',
    phone: '+8801700000000',
    email: null,
    address: null,
    notes: null,
    archivedAt: null,
    version: 1,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage() {
  return render(
    <ThemeBoundary>
      <CustomersPage />
    </ThemeBoundary>,
  );
}

describe('CustomersPage', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // covers AC-14: the first list load is announced, not just drawn as skeletons
  it('announces the first list load', () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/customers?')) {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(jsonResponse(404, { error: 'NOT_FOUND' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    const loading = screen.getByText('Loading customers…');
    expect(loading.closest('[role="status"]')).not.toBeNull();
    expect(loading).toHaveClass('sr-only');
  });

  it('announces the empty customer list', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/customers?')) {
        return Promise.resolve(
          jsonResponse(200, { success: true, data: { items: [], nextCursor: null } }),
        );
      }
      return Promise.resolve(jsonResponse(404, { error: 'NOT_FOUND' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    const empty = await screen.findByText('No customers yet');
    expect(empty).toBeVisible();
    expect(empty.closest('[role="status"]')).not.toBeNull();
  });

  it('renders a loaded customer row', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/customers?')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: { items: [makeCustomer()], nextCursor: null },
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { error: 'NOT_FOUND' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    expect((await screen.findAllByRole('link', { name: 'Nusrat Jahan' }))[0]).toHaveAttribute(
      'href',
      '/customers/customer-1',
    );
  });

  // covers silent paging: the next page request must not repeat while it is in
  // flight, and the buttons stay locked until it settles
  it('locks paging while the next page loads', async () => {
    let listCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith('/api/customers?')) {
        return Promise.resolve(jsonResponse(404, { error: 'NOT_FOUND' }));
      }
      listCalls += 1;
      if (listCalls > 1) {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          data: { items: [makeCustomer()], nextCursor: 'cursor-2' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findAllByRole('link', { name: 'Nusrat Jahan' });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.queryByText('Loading customers…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(listCalls).toBe(2);
  });
});
