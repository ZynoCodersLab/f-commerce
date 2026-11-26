'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Plus, Search, ShoppingBag } from 'lucide-react';
import type {
  OrderStatusType,
  OrderSummaryDto,
  PaymentStatusFilterType,
} from '@f-commerce/contracts';
import { AppShell } from '@/components/shell/shell';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  Input,
  RecordCard,
  Skeleton,
} from '@/components/ui/primitives';
import { OrderStatusBadge } from '@/components/orders/order-status';
import { OrderDeadlineCell } from '@/components/orders/order-deadline';
import { PaymentStatusBadge } from '@/components/payments/payment-status-badge';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { formatDateTime, formatMoney } from '@/lib/catalog-format';
import { useRequireAuth } from '@/lib/auth-guard';
import { listOrders } from '@/lib/order-client';
import { ORDER_ACTIVE_STATUSES, ORDER_STATUS_LABEL, orderSourceLabel } from '@/lib/order-form';

const PAGE_SIZE = 20;

type StatusFilter = 'active' | 'all' | OrderStatusType;
type PaymentFilter = 'all' | 'has_due' | PaymentStatusFilterType;

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'all', label: 'All' },
  ...ORDER_ACTIVE_STATUSES.map((status) => ({
    key: status,
    label: ORDER_STATUS_LABEL[status],
  })),
  { key: 'DELIVERED', label: ORDER_STATUS_LABEL.DELIVERED },
  { key: 'CANCELLED', label: ORDER_STATUS_LABEL.CANCELLED },
  { key: 'RETURNED', label: ORDER_STATUS_LABEL.RETURNED },
];

const PAYMENT_FILTERS: { key: PaymentFilter; label: string }[] = [
  { key: 'all', label: 'All payments' },
  { key: 'has_due', label: 'Has due' },
  { key: 'UNPAID', label: 'Unpaid' },
  { key: 'PARTIAL', label: 'Partial' },
  { key: 'PAID', label: 'Paid' },
  { key: 'REFUND_OWED', label: 'Refund owed' },
];

function statusesForFilter(filter: StatusFilter): OrderStatusType[] | undefined {
  if (filter === 'active') return ORDER_ACTIVE_STATUSES;
  if (filter === 'all') return undefined;
  return [filter];
}

function paymentStatusesForFilter(filter: PaymentFilter): PaymentStatusFilterType[] | undefined {
  if (filter === 'all') return undefined;
  if (filter === 'has_due') return ['UNPAID', 'PARTIAL'];
  return [filter];
}

export default function OrdersPage() {
  const ready = useRequireAuth();
  const { currency, timezone } = useBusinessSettings();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('active');
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>('all');
  const [rows, setRows] = useState<OrderSummaryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const requestEpoch = useRef(0);

  /** Invalidate any in flight page request when the list view changes. */
  const invalidateListRequests = () => {
    requestEpoch.current += 1;
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;

    listOrders({
      statuses: statusesForFilter(filter),
      paymentStatuses: paymentStatusesForFilter(paymentFilter),
      q: debouncedQuery,
      limit: PAGE_SIZE,
    })
      .then((page) => {
        if (cancelled) return;
        setRows(page.items);
        setNextCursor(page.nextCursor);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows([]);
        setNextCursor(null);
        setError(err instanceof Error ? err.message : 'Orders could not be loaded');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, filter, paymentFilter, reloadToken]);

  const loadMore = async () => {
    if (nextCursor === null || isLoading) return;
    const epoch = requestEpoch.current;
    setIsLoading(true);
    setError(null);
    try {
      const page = await listOrders({
        statuses: statusesForFilter(filter),
        paymentStatuses: paymentStatusesForFilter(paymentFilter),
        q: debouncedQuery,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      if (epoch !== requestEpoch.current) return;
      setRows((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (epoch !== requestEpoch.current) return;
      setError(err instanceof Error ? err.message : 'Orders could not be loaded');
    } finally {
      if (epoch === requestEpoch.current) setIsLoading(false);
    }
  };

  const filtersActive =
    filter !== 'active' || paymentFilter !== 'all' || debouncedQuery.trim() !== '';

  const clearFilters = () => {
    invalidateListRequests();
    setFilter('active');
    setPaymentFilter('all');
    setQuery('');
    setDebouncedQuery('');
    setRows([]);
    setNextCursor(null);
    setIsLoading(true);
    setError(null);
  };

  const changeFilter = (next: StatusFilter) => {
    if (next === filter) return;
    invalidateListRequests();
    setFilter(next);
    setRows([]);
    setNextCursor(null);
    setIsLoading(true);
    setError(null);
  };

  const changePaymentFilter = (next: PaymentFilter) => {
    if (next === paymentFilter) return;
    invalidateListRequests();
    setPaymentFilter(next);
    setRows([]);
    setNextCursor(null);
    setIsLoading(true);
    setError(null);
  };

  const retry = () => {
    invalidateListRequests();
    setRows([]);
    setNextCursor(null);
    setIsLoading(true);
    setError(null);
    setReloadToken((current) => current + 1);
  };

  const columns = [
    {
      key: 'orderNumber' as const,
      label: 'Order',
      render: (row: OrderSummaryDto) => (
        <Link
          className="font-mono font-semibold text-sky-strong hover:underline"
          href={`/orders/${row.id}`}
        >
          {row.orderNumber}
        </Link>
      ),
    },
    {
      key: 'customerName' as const,
      label: 'Customer',
      render: (row: OrderSummaryDto) => (
        <span className="font-semibold text-ink">{row.customerName}</span>
      ),
    },
    {
      key: 'status' as const,
      label: 'Status',
      render: (row: OrderSummaryDto) => <OrderStatusBadge status={row.status} />,
    },
    {
      key: 'paymentStatus' as const,
      label: 'Payment',
      render: (row: OrderSummaryDto) => <PaymentStatusBadge status={row.paymentStatus} />,
    },
    {
      key: 'deliveryDeadline' as const,
      label: 'Delivery deadline',
      render: (row: OrderSummaryDto) => <OrderDeadlineCell row={row} />,
    },
    {
      key: 'total' as const,
      label: 'Total',
      render: (row: OrderSummaryDto) => (
        <span className="font-mono text-ink">{formatMoney(row.total, currency)}</span>
      ),
    },
    {
      key: 'dueAmount' as const,
      label: 'Due',
      render: (row: OrderSummaryDto) => (
        <span className="font-mono text-ink">{formatMoney(row.dueAmount, currency)}</span>
      ),
    },
    {
      key: 'source' as const,
      label: 'Source',
      render: (row: OrderSummaryDto) => (
        <span className="text-body">{orderSourceLabel(row.source)}</span>
      ),
    },
    {
      key: 'createdAt' as const,
      label: 'Created',
      render: (row: OrderSummaryDto) => (
        <span className="text-body">{formatDateTime(row.createdAt, timezone)}</span>
      ),
    },
  ];

  const emptyTitle = (() => {
    if (debouncedQuery.trim() !== '') return `No orders match “${debouncedQuery.trim()}”`;
    if (paymentFilter !== 'all') return 'No orders match these filters';
    if (filter === 'active') return 'No active orders';
    if (filter === 'all') return 'No orders yet';
    return `No ${ORDER_STATUS_LABEL[filter].toLowerCase()} orders`;
  })();

  if (!ready) {
    return (
      <AppShell>
        <Skeleton className="h-64 w-full" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="grid gap-8">
        <header className="grid gap-4 sm:flex sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-sky-strong">
              Sales queue
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">Orders</h1>
            <p className="mt-2 max-w-xl text-base leading-7 text-body">
              Follow every sale from the first message to the final handoff. Search by order,
              customer, or phone.
            </p>
          </div>
          <Link
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-sky px-4 text-sm font-semibold text-on-sky transition-colors hover:bg-sky-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky sm:w-auto"
            href="/orders/new"
          >
            <Plus aria-hidden="true" size={18} />
            New order
          </Link>
        </header>

        <section aria-labelledby="order-filters-title" className="grid gap-4">
          <h2 className="sr-only" id="order-filters-title">
            Find orders
          </h2>

          <FilterBar>
            <div className="min-w-0 flex-1">
              <Field htmlFor="order-search" label="Search orders">
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                    size={18}
                  />
                  <Input
                    autoComplete="off"
                    className="pl-10"
                    id="order-search"
                    onChange={(event) => {
                      invalidateListRequests();
                      setQuery(event.target.value);
                      setRows([]);
                      setNextCursor(null);
                      setIsLoading(true);
                      setError(null);
                    }}
                    placeholder="Order number, customer name, or phone"
                    type="search"
                    value={query}
                  />
                </div>
              </Field>
            </div>
            {filtersActive && (
              <Button onClick={clearFilters} type="button" variant="quiet">
                Clear filters
              </Button>
            )}
          </FilterBar>

          <div aria-label="Filter orders by status" className="flex flex-wrap gap-2" role="group">
            {FILTERS.map((entry) => {
              const active = filter === entry.key;
              return (
                <button
                  aria-pressed={active}
                  className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky ${
                    active
                      ? 'border-sky bg-sky text-on-sky'
                      : 'border-border bg-surface text-body hover:border-sky hover:text-ink'
                  }`}
                  key={entry.key}
                  onClick={() => changeFilter(entry.key)}
                  type="button"
                >
                  {entry.label}
                </button>
              );
            })}
          </div>

          <div
            aria-label="Filter orders by payment status"
            className="flex flex-wrap gap-2"
            role="group"
          >
            {PAYMENT_FILTERS.map((entry) => {
              const active = paymentFilter === entry.key;
              return (
                <button
                  aria-pressed={active}
                  className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky ${
                    active
                      ? 'border-sky bg-sky-soft text-sky-strong'
                      : 'border-border bg-surface text-body hover:border-sky hover:text-ink'
                  }`}
                  key={entry.key}
                  onClick={() => changePaymentFilter(entry.key)}
                  type="button"
                >
                  {entry.label}
                </button>
              );
            })}
          </div>
        </section>

        {isLoading && rows.length === 0 && (
          <div className="grid gap-3" role="status">
            <span className="sr-only">Loading orders…</span>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {error !== null && <ErrorState onRetry={retry}>{error}</ErrorState>}

        {!isLoading && error === null && rows.length === 0 && (
          <div role="status">
            <EmptyState>
              <div>
                <ShoppingBag aria-hidden="true" className="mx-auto mb-3 text-muted" size={28} />
                <p className="font-semibold text-ink">{emptyTitle}</p>
                <p className="mt-1 text-sm text-body">
                  {debouncedQuery.trim() !== ''
                    ? 'Try a shorter search, or clear the filters to see the full queue.'
                    : 'Create an order to start the queue.'}
                </p>
                {debouncedQuery.trim() === '' && (
                  <Link
                    className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-md bg-sky px-4 text-sm font-semibold text-on-sky hover:bg-sky-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky"
                    href="/orders/new"
                  >
                    <Plus aria-hidden="true" size={18} />
                    New order
                  </Link>
                )}
              </div>
            </EmptyState>
          </div>
        )}

        {rows.length > 0 && (
          <Card className="overflow-hidden p-0">
            <DataTable columns={columns} rows={rows} />
            <div className="grid gap-3 p-4 md:hidden">
              {rows.map((row) => (
                <RecordCard key={row.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link
                        className="font-mono text-sm font-semibold text-sky-strong hover:underline"
                        href={`/orders/${row.id}`}
                      >
                        {row.orderNumber}
                      </Link>
                      <h3 className="mt-1 font-semibold text-ink">{row.customerName}</h3>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <OrderStatusBadge status={row.status} />
                      <PaymentStatusBadge status={row.paymentStatus} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm">
                    <div>
                      <p className="text-muted">Total</p>
                      <p className="mt-1 font-mono text-ink">{formatMoney(row.total, currency)}</p>
                    </div>
                    <div>
                      <p className="text-muted">Due</p>
                      <p className="mt-1 font-mono text-ink">
                        {formatMoney(row.dueAmount, currency)}
                      </p>
                    </div>
                  </div>
                  <div className="text-sm">
                    <p className="text-muted">Delivery deadline</p>
                    <div className="mt-1">
                      <OrderDeadlineCell row={row} />
                    </div>
                  </div>
                  <p className="text-sm text-muted">
                    {orderSourceLabel(row.source)} · {formatDateTime(row.createdAt, timezone)}
                  </p>
                </RecordCard>
              ))}
            </div>
          </Card>
        )}

        {rows.length > 0 && nextCursor !== null && (
          <div className="flex justify-center">
            <Button
              disabled={isLoading}
              onClick={() => void loadMore()}
              type="button"
              variant="secondary"
            >
              {isLoading ? 'Loading…' : 'Load more orders'}
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
