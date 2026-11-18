import { act, screen, waitFor } from '@testing-library/react';
import { render } from '@/test-utils/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderSummaryDto } from '@f-commerce/contracts';

import { ThemeBoundary } from '@/components/theme/theme';
import { setAuth } from '@/lib/auth-client';

const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/orders',
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
}));

import OrdersPage from './page';

const created = '2026-10-20T10:00:00.000Z';

function makeOrder(overrides: Partial<OrderSummaryDto> = {}): OrderSummaryDto {
  return {
    id: 'order-1',
    orderNumber: 'ORD-0001',
    status: 'PENDING',
    customerName: 'Nusrat Jahan',
    total: 9350,
    dueAmount: 9350,
    source: 'FACEBOOK',
    deliveryDeadline: null,
    itemCount: 2,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installedFetch(
  handler: (url: string, init?: RequestInit) => Response | undefined,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      handler(String(input), init) ??
        jsonResponse(404, { error: 'NOT_FOUND', message: 'Not found' }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function metadata(url: string): Response | undefined {
  if (url === '/api/business/me') {
    return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
  }
  return undefined;
}

function renderPage() {
  return render(
    <ThemeBoundary>
      <OrdersPage />
    </ThemeBoundary>,
  );
}

describe('OrdersPage', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the active queue with money in the business currency', async () => {
    const fetchMock = installedFetch((url) => {
      if (url.startsWith('/api/orders?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [makeOrder()], nextCursor: null },
        });
      }
      return metadata(url);
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Orders' })).toBeVisible();
    const orderLinks = await screen.findAllByRole('link', { name: 'ORD-0001' });
    expect(orderLinks[0]).toHaveAttribute('href', '/orders/order-1');
    expect(screen.getAllByText('Nusrat Jahan').length).toBeGreaterThan(0);
    expect(screen.getAllByText('9,350 BDT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Facebook').length).toBeGreaterThan(0);

    const listCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith('/api/orders?'),
    );
    expect(listCall).toBeDefined();
    expect(String(listCall?.[0])).toContain('status=PENDING%2CCONFIRMED%2CPROCESSING%2CSHIPPED');
  });

  // covers AC-14: the first list load is announced, not just drawn as skeletons
  it('announces the first list load', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/orders?')) {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(metadata(url) ?? jsonResponse(404, { error: 'NOT_FOUND' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    const loading = screen.getByText('Loading orders…');
    expect(loading.closest('[role="status"]')).not.toBeNull();
    expect(loading).toHaveClass('sr-only');
  });

  it('sends the status filter and debounced search to the list request', async () => {
    const user = userEvent.setup();
    const fetchMock = installedFetch((url) => {
      if (url.startsWith('/api/orders?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [makeOrder()], nextCursor: null },
        });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findAllByRole('link', { name: 'ORD-0001' });

    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            String(input).startsWith('/api/orders?') && !String(input).includes('status='),
        ),
      ).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: 'Shipped' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('status=SHIPPED'))).toBe(
        true,
      );
    });

    await user.type(screen.getByLabelText('Search orders'), 'Nusrat');
    await waitFor(
      () => {
        expect(
          fetchMock.mock.calls.some(
            ([input]) =>
              String(input).includes('q=Nusrat') && String(input).includes('status=SHIPPED'),
          ),
        ).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it('appends the next page when the seller loads more', async () => {
    const user = userEvent.setup();
    installedFetch((url) => {
      if (url.includes('cursor=cursor-1')) {
        return jsonResponse(200, {
          success: true,
          data: {
            items: [makeOrder({ id: 'order-2', orderNumber: 'ORD-0002', customerName: 'Rafi' })],
            nextCursor: null,
          },
        });
      }
      if (url.startsWith('/api/orders?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [makeOrder()], nextCursor: 'cursor-1' },
        });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findAllByRole('link', { name: 'ORD-0001' });

    const loadMore = screen.getByRole('button', { name: 'Load more orders' });
    await waitFor(() => expect(loadMore).not.toBeDisabled());
    await user.click(loadMore);

    expect(await screen.findAllByRole('link', { name: 'ORD-0002' })).not.toHaveLength(0);
    expect(screen.getAllByRole('link', { name: 'ORD-0001' }).length).toBeGreaterThan(0);
  });

  it('drops a load more response that lands after the filter changed', async () => {
    const user = userEvent.setup();
    let resolveStale: ((response: Response) => void) | undefined;
    const stalePage = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('cursor=cursor-1')) return stalePage;
      if (url.includes('status=SHIPPED')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: {
              items: [
                makeOrder({
                  id: 'order-3',
                  orderNumber: 'ORD-0003',
                  customerName: 'Shipped buyer',
                  status: 'SHIPPED',
                }),
              ],
              nextCursor: null,
            },
          }),
        );
      }
      if (url.startsWith('/api/orders?')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            data: { items: [makeOrder()], nextCursor: 'cursor-1' },
          }),
        );
      }
      return Promise.resolve(
        metadata(url) ?? jsonResponse(404, { error: 'NOT_FOUND', message: 'Not found' }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findAllByRole('link', { name: 'ORD-0001' });

    const loadMore = screen.getByRole('button', { name: 'Load more orders' });
    await waitFor(() => expect(loadMore).not.toBeDisabled());
    await user.click(loadMore);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('cursor=cursor-1')),
      ).toBe(true),
    );

    await user.click(screen.getByRole('button', { name: 'Shipped' }));
    expect(await screen.findAllByRole('link', { name: 'ORD-0003' })).not.toHaveLength(0);

    await act(async () => {
      resolveStale?.(
        jsonResponse(200, {
          success: true,
          data: {
            items: [makeOrder({ id: 'order-2', orderNumber: 'ORD-0002', customerName: 'Rafi' })],
            nextCursor: null,
          },
        }),
      );
    });

    expect(screen.queryByRole('link', { name: 'ORD-0002' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'ORD-0003' }).length).toBeGreaterThan(0);
  });

  it('shows an empty state that points to the first order', async () => {
    installedFetch((url) => {
      if (url.startsWith('/api/orders?')) {
        return jsonResponse(200, { success: true, data: { items: [], nextCursor: null } });
      }
      return metadata(url);
    });

    renderPage();

    expect(await screen.findByText('No active orders')).toBeVisible();
    expect(screen.getByText('No active orders').closest('[role="status"]')).not.toBeNull();
    expect(screen.getAllByRole('link', { name: 'New order' })[0]).toHaveAttribute(
      'href',
      '/orders/new',
    );
  });

  // covers AC-14 and AC-19: the queue shows the promise, the missing one, and the late flag
  it('shows the delivery deadline and flags a late active order only', async () => {
    installedFetch((url) => {
      if (url.startsWith('/api/orders?')) {
        return jsonResponse(200, {
          success: true,
          data: {
            items: [
              makeOrder({ deliveryDeadline: '2020-01-01' }),
              makeOrder({ id: 'order-2', orderNumber: 'ORD-0002', deliveryDeadline: null }),
              makeOrder({
                id: 'order-3',
                orderNumber: 'ORD-0003',
                status: 'DELIVERED',
                deliveryDeadline: '2020-01-01',
              }),
            ],
            nextCursor: null,
          },
        });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findAllByRole('link', { name: 'ORD-0001' });

    // The table and the mobile record card both render the cell, and two rows share the day.
    expect(screen.getAllByText('Jan 1, 2020')).toHaveLength(4);
    expect(screen.getAllByText('Overdue')).toHaveLength(2);
    expect(screen.getAllByText('Not set')).toHaveLength(2);
  });

  // covers AC-14: an empty search result names the term instead of the queue
  it('names the search term when no order matches', async () => {
    const user = userEvent.setup();
    installedFetch((url) => {
      if (url.startsWith('/api/orders?')) {
        return jsonResponse(200, { success: true, data: { items: [], nextCursor: null } });
      }
      return metadata(url);
    });

    renderPage();
    await screen.findByText('No active orders');

    await user.type(screen.getByLabelText('Search orders'), 'Nusrat');

    expect(await screen.findByText('No orders match “Nusrat”')).toBeVisible();
  });

  it('shows the server error and retries the list', async () => {
    const user = userEvent.setup();
    let calls = 0;
    installedFetch((url) => {
      if (url.startsWith('/api/orders?')) {
        calls += 1;
        if (calls === 1) {
          return jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'Orders unavailable' });
        }
        return jsonResponse(200, {
          success: true,
          data: { items: [makeOrder()], nextCursor: null },
        });
      }
      return metadata(url);
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Orders unavailable');
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findAllByRole('link', { name: 'ORD-0001' })).not.toHaveLength(0);
  });
});
