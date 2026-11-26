import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderDto, OrderStatusType, OrderSummaryDto } from '@f-commerce/contracts';

import { render } from '@/test-utils/render';
import { OrderDeadlineBadge, OrderDeadlineCell, OrderDeadlineSummary } from './order-deadline';

const created = '2026-10-20T10:00:00.000Z';

function makeSummary(overrides: Partial<OrderSummaryDto> = {}): OrderSummaryDto {
  return {
    id: 'order-1',
    orderNumber: 'ORD-0001',
    status: 'PENDING',
    customerName: 'Nusrat Jahan',
    total: 9350,
    paidAmount: 0,
    dueAmount: 9350,
    refundOwed: 0,
    paymentStatus: 'UNPAID',
    source: 'FACEBOOK',
    deliveryDeadline: '2026-11-04',
    itemCount: 2,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderDto> = {}): OrderDto {
  return {
    id: 'order-1',
    orderNumber: 'ORD-0001',
    status: 'PENDING',
    source: 'FACEBOOK',
    customerId: '11111111-1111-4111-8111-111111111111',
    customerName: 'Nusrat Jahan',
    customerPhone: '01700000000',
    shippingAddress: '12 Hazaribagh Road, Dhaka',
    notes: null,
    deliveryDeadline: '2026-11-04',
    subtotal: 9000,
    deliveryFee: 350,
    discount: 0,
    total: 9350,
    paidAmount: 0,
    dueAmount: 9350,
    refundOwed: 0,
    paymentStatus: 'UNPAID',
    version: 1,
    createdAt: created,
    updatedAt: created,
    items: [],
    history: [],
    payments: [],
    ...overrides,
  };
}

describe('order deadline badge', () => {
  beforeEach(() => {
    // Fixed at local noon so "today" is unambiguous in every timezone.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // covers AC-9: the badge is derived from the promise, not stored
  it('marks an active order past its promised day as overdue', () => {
    render(<OrderDeadlineBadge deliveryDeadline="2026-11-04" status="PENDING" />);

    expect(screen.getByText('Overdue')).toBeVisible();
  });

  // covers AC-9: a promise of today or a future day is not late
  it('renders no badge for today or a future day', () => {
    const first = render(<OrderDeadlineBadge deliveryDeadline="2026-11-05" status="PENDING" />);
    expect(screen.queryByText('Overdue')).toBeNull();
    first.unmount();

    render(<OrderDeadlineBadge deliveryDeadline="2026-11-06" status="PENDING" />);
    expect(screen.queryByText('Overdue')).toBeNull();
  });

  // covers AC-9: a finished order keeps its promise but is never late
  it.each<OrderStatusType>(['DELIVERED', 'CANCELLED', 'RETURNED'])(
    'renders no badge for a past promise on a %s order',
    (status) => {
      render(<OrderDeadlineBadge deliveryDeadline="2026-11-04" status={status} />);

      expect(screen.queryByText('Overdue')).toBeNull();
    },
  );

  // covers AC-9: an order with no promise cannot be late
  it('renders no badge when no deadline is set', () => {
    render(<OrderDeadlineBadge deliveryDeadline={null} status="PENDING" />);

    expect(screen.queryByText('Overdue')).toBeNull();
  });
});

describe('order deadline cell', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // covers AC-14 and AC-9: a list row shows the promised day and flags lateness
  it('shows the formatted promise with the overdue badge', () => {
    render(<OrderDeadlineCell row={makeSummary({ deliveryDeadline: '2026-11-04' })} />);

    expect(screen.getByText('Nov 4, 2026')).toBeVisible();
    expect(screen.getByText('Overdue')).toBeVisible();
  });

  // covers AC-14: a missing promise reads as not set
  it('shows Not set when the row has no promise', () => {
    render(<OrderDeadlineCell row={makeSummary({ deliveryDeadline: null })} />);

    expect(screen.getByText('Not set')).toBeVisible();
    expect(screen.queryByText('Overdue')).toBeNull();
  });

  // covers AC-14 and AC-9: a delivered row keeps its date without a late flag
  it('shows the promise on a delivered row without a badge', () => {
    render(
      <OrderDeadlineCell
        row={makeSummary({ deliveryDeadline: '2026-11-04', status: 'DELIVERED' })}
      />,
    );

    expect(screen.getByText('Nov 4, 2026')).toBeVisible();
    expect(screen.queryByText('Overdue')).toBeNull();
  });
});

describe('order deadline summary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // covers AC-16 and AC-9: the detail header shows the promise and its flag
  it('shows the formatted promise with the overdue badge', () => {
    render(<OrderDeadlineSummary order={makeOrder({ deliveryDeadline: '2026-11-04' })} />);

    expect(screen.getByText('Nov 4, 2026')).toBeVisible();
    expect(screen.getByText('Overdue')).toBeVisible();
  });

  // covers AC-16: a missing promise reads as not set on the detail header
  it('shows Not set when the order has no promise', () => {
    render(<OrderDeadlineSummary order={makeOrder({ deliveryDeadline: null })} />);

    expect(screen.getByText('Not set')).toBeVisible();
    expect(screen.queryByText('Overdue')).toBeNull();
  });
});
