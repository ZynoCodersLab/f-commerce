import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentLedgerItemDto, PaymentLedgerPageDto } from '@f-commerce/contracts';
import { ThemeBoundary } from '@/components/theme/theme';
import { setAuth } from '@/lib/auth-client';
import { render } from '@/test-utils/render';

const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/payments',
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
}));

import PaymentsPage from './page';

function makeItem(overrides: Partial<PaymentLedgerItemDto> = {}): PaymentLedgerItemDto {
  return {
    id: 'pay-1',
    orderId: 'ord-1',
    orderNumber: 'ORD-0001',
    customerName: 'Nusrat Jahan',
    kind: 'PAYMENT',
    amount: 500,
    method: 'BKASH',
    referenceNumber: 'TRX-100',
    notes: null,
    paymentDate: '2026-11-26',
    recordedByName: 'Maya Owner',
    createdAt: '2026-11-26T10:00:00.000Z',
    voidedAt: null,
    voidedByName: null,
    voidReason: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(
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

describe('PaymentsPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    replaceMock.mockReset();
    pushMock.mockReset();
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // covers spec 0010 AC-17 & AC-21: explicit month range, summary totals, order link, voided badge, Load more
  it('loads this month so far with explicit dates, renders summary and rows, and pages with Load more', async () => {
    const user = userEvent.setup();
    const page1: PaymentLedgerPageDto = {
      items: [
        makeItem(),
        makeItem({
          id: 'pay-2',
          kind: 'PAYMENT',
          amount: 300,
          voidedAt: '2026-11-26T11:00:00.000Z',
          voidedByName: 'Maya Owner',
          voidReason: 'Duplicate entry',
        }),
      ],
      summary: { collected: 1200, refunded: 200, net: 1000 },
      nextCursor: 'cursor-page-2',
    };
    const page2: PaymentLedgerPageDto = {
      items: [
        makeItem({
          id: 'pay-3',
          orderId: 'ord-2',
          orderNumber: 'ORD-0002',
          customerName: 'Tanvir Ahmed',
          kind: 'REFUND',
          amount: 200,
          method: 'CASH',
          referenceNumber: null,
        }),
      ],
      summary: { collected: 1200, refunded: 200, net: 1000 },
      nextCursor: null,
    };

    const requestedUrls: string[] = [];
    installFetch((url) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, {
          success: true,
          data: {
            name: 'Maya Traders',
            currency: 'USD',
            timezone: 'Asia/Dhaka',
            logoUrl: null,
            address: null,
            onboardingComplete: true,
            role: 'STAFF',
          },
        });
      }
      if (url.startsWith('/api/payments')) {
        requestedUrls.push(url);
        if (url.includes('cursor=cursor-page-2')) {
          return jsonResponse(200, { success: true, data: page2 });
        }
        return jsonResponse(200, { success: true, data: page1 });
      }
      return undefined;
    });

    render(
      <ThemeBoundary>
        <PaymentsPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeVisible();
    await waitFor(() => {
      expect(requestedUrls.some((u) => u.includes('from=2026-11-01&to=2026-11-26'))).toBe(true);
    });

    // Summary totals reflect range totals excluding voided entries.
    const totalsRegion = screen.getByRole('region', { name: 'Payment totals' });
    expect(within(totalsRegion).getByText('1,200 USD')).toBeVisible();
    expect(within(totalsRegion).getByText('200 USD')).toBeVisible();
    expect(within(totalsRegion).getByText('1,000 USD')).toBeVisible();

    // All 8 methods stay available in the filter even for a USD business (AC-13, AC-21).
    const methodSelect = screen.getByLabelText('Method');
    expect(within(methodSelect).getByRole('option', { name: 'bKash' })).toBeInTheDocument();
    expect(within(methodSelect).getByRole('option', { name: 'Nagad' })).toBeInTheDocument();

    // Order links point to /orders/[id] and voided rows show the Voided badge.
    expect(screen.getAllByRole('link', { name: 'ORD-0001' })[0]).toHaveAttribute(
      'href',
      '/orders/ord-1',
    );
    expect(screen.getAllByText('Voided').length).toBeGreaterThan(0);

    // Advance past midnight before clicking Load more: explicit dates from page 1 must be reused.
    vi.setSystemTime(new Date('2026-11-27T12:00:00.000Z'));
    await user.click(screen.getByRole('button', { name: 'Load more payments' }));

    await waitFor(() => {
      expect(screen.getAllByText('ORD-0002').length).toBeGreaterThan(0);
    });
    const page2Url = requestedUrls.find((u) => u.includes('cursor=cursor-page-2'));
    expect(page2Url).toContain('from=2026-11-01&to=2026-11-26');
  });

  // covers spec 0010 AC-21: empty, filter no match, and error states
  it('shows empty state, filter changes, and error retry state', async () => {
    const user = userEvent.setup();
    let failNext = true;

    installFetch((url) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, {
          success: true,
          data: {
            name: 'Maya Traders',
            currency: 'BDT',
            timezone: 'Asia/Dhaka',
            logoUrl: null,
            address: null,
            onboardingComplete: true,
            role: 'OWNER',
          },
        });
      }
      if (url.startsWith('/api/payments')) {
        if (failNext) {
          return jsonResponse(500, { error: 'INTERNAL_ERROR', message: 'Database unavailable' });
        }
        return jsonResponse(200, {
          success: true,
          data: { items: [], summary: { collected: 0, refunded: 0, net: 0 }, nextCursor: null },
        });
      }
      return undefined;
    });

    render(
      <ThemeBoundary>
        <PaymentsPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByText('Database unavailable')).toBeVisible();

    failNext = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No payments this month')).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Type'), 'REFUND');
    expect(await screen.findByText('No payments match these filters')).toBeVisible();
  });

  // covers spec 0010 AC-17 and AC-21: negative net summary and inverted date range guard with Reset filters
  it('renders negative net summary and blocks inverted date ranges before calling the API', async () => {
    const user = userEvent.setup();
    const requestedUrls: string[] = [];

    installFetch((url) => {
      if (url === '/api/business/me') {
        return jsonResponse(200, {
          success: true,
          data: {
            name: 'Maya Traders',
            currency: 'BDT',
            timezone: 'Asia/Dhaka',
            logoUrl: null,
            address: null,
            onboardingComplete: true,
            role: 'OWNER',
          },
        });
      }
      if (url.startsWith('/api/payments')) {
        requestedUrls.push(url);
        return jsonResponse(200, {
          success: true,
          data: {
            items: [
              makeItem({
                kind: 'REFUND',
                amount: 300,
                method: 'CASH',
              }),
            ],
            summary: { collected: 0, refunded: 300, net: -300 },
            nextCursor: null,
          } satisfies PaymentLedgerPageDto,
        });
      }
      return undefined;
    });

    render(
      <ThemeBoundary>
        <PaymentsPage />
      </ThemeBoundary>,
    );

    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeVisible();
    const totalsRegion = screen.getByRole('region', { name: 'Payment totals' });
    expect(within(totalsRegion).getByText('−300 BDT')).toBeVisible();

    const callsBefore = requestedUrls.length;
    const fromInput = screen.getByLabelText('From date');
    const toInput = screen.getByLabelText('To date');
    await user.clear(fromInput);
    await user.type(fromInput, '2026-12-20');
    await user.clear(toInput);
    await user.type(toInput, '2026-12-01');

    expect(await screen.findByText('Start date must be on or before end date.')).toBeVisible();
    expect(requestedUrls).toHaveLength(callsBefore);

    await user.click(screen.getAllByRole('button', { name: 'Reset filters' })[0]);
    await waitFor(() => {
      expect(requestedUrls.length).toBeGreaterThan(callsBefore);
    });
    expect(screen.queryByText('Start date must be on or before end date.')).not.toBeInTheDocument();
  });
});
