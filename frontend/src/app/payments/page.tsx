'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Wallet } from 'lucide-react';
import {
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  type PaymentKindType,
  type PaymentLedgerItemDto,
  type PaymentLedgerSummaryDto,
  type PaymentMethodType,
} from '@f-commerce/contracts';
import { AppShell } from '@/components/shell/shell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  Input,
  RecordCard,
  Select,
  Skeleton,
} from '@/components/ui/primitives';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { useRequireAuth } from '@/lib/auth-guard';
import { formatDateOnly, formatMoney } from '@/lib/catalog-format';
import { listPayments } from '@/lib/payment-client';
import { PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL } from '@/lib/payment-format';
import { todayInTimeZone } from '@/lib/timezone';

const PAGE_SIZE = 20;

interface ActiveLedgerQuery {
  from: string;
  to: string;
  method: PaymentMethodType | '';
  kind: PaymentKindType | '';
}

function defaultRangeForZone(timezone: string): { from: string; to: string } {
  const today = todayInTimeZone(timezone);
  return {
    from: `${today.slice(0, 7)}-01`,
    to: today,
  };
}

export default function PaymentsPage() {
  const ready = useRequireAuth();
  const { currency, timezone, mounted } = useBusinessSettings();

  const [fromOverride, setFromOverride] = useState<string | null>(null);
  const [toOverride, setToOverride] = useState<string | null>(null);
  const [methodFilter, setMethodFilter] = useState<PaymentMethodType | ''>('');
  const [kindFilter, setKindFilter] = useState<PaymentKindType | ''>('');

  const [rows, setRows] = useState<PaymentLedgerItemDto[]>([]);
  const [summary, setSummary] = useState<PaymentLedgerSummaryDto>({
    collected: 0,
    refunded: 0,
    net: 0,
  });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [rangeResetToken, setRangeResetToken] = useState(0);

  const requestEpoch = useRef(0);
  // Capture the exact explicit filter range used for page 1 so Load more never drifts across midnight.
  const activeQueryRef = useRef<ActiveLedgerQuery | null>(null);

  const defaults = useMemo(
    () => (mounted ? defaultRangeForZone(timezone) : null),
    // rangeResetToken lets Reset filters explicitly refresh to the current business month without drifting on Load more.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, timezone, rangeResetToken],
  );
  const effectiveFrom = fromOverride ?? defaults?.from ?? '';
  const effectiveTo = toOverride ?? defaults?.to ?? '';
  const rangeInvalid = effectiveFrom !== '' && effectiveTo !== '' && effectiveFrom > effectiveTo;

  const invalidateRequests = () => {
    requestEpoch.current += 1;
  };

  useEffect(() => {
    if (!ready || !mounted || effectiveFrom === '' || effectiveTo === '' || rangeInvalid) return;

    let cancelled = false;
    const epoch = ++requestEpoch.current;
    const currentQuery: ActiveLedgerQuery = {
      from: effectiveFrom,
      to: effectiveTo,
      method: methodFilter,
      kind: kindFilter,
    };

    listPayments({
      from: currentQuery.from,
      to: currentQuery.to,
      methods: currentQuery.method !== '' ? [currentQuery.method] : undefined,
      kind: currentQuery.kind,
      limit: PAGE_SIZE,
    })
      .then((page) => {
        if (cancelled || epoch !== requestEpoch.current) return;
        activeQueryRef.current = currentQuery;
        setRows(page.items);
        setSummary(page.summary);
        setNextCursor(page.nextCursor);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || epoch !== requestEpoch.current) return;
        setRows([]);
        setSummary({ collected: 0, refunded: 0, net: 0 });
        setNextCursor(null);
        setError(err instanceof Error ? err.message : 'Payments could not be loaded');
      })
      .finally(() => {
        if (!cancelled && epoch === requestEpoch.current) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    ready,
    mounted,
    effectiveFrom,
    effectiveTo,
    rangeInvalid,
    methodFilter,
    kindFilter,
    reloadToken,
  ]);

  const loadMore = async () => {
    const active = activeQueryRef.current;
    if (nextCursor === null || isLoading || active === null) return;
    const epoch = requestEpoch.current;
    setIsLoading(true);
    setError(null);
    try {
      const page = await listPayments({
        from: active.from,
        to: active.to,
        methods: active.method !== '' ? [active.method] : undefined,
        kind: active.kind,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      if (epoch !== requestEpoch.current) return;
      setRows((current) => [...current, ...page.items]);
      setSummary(page.summary);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (epoch !== requestEpoch.current) return;
      setError(err instanceof Error ? err.message : 'Payments could not be loaded');
    } finally {
      if (epoch === requestEpoch.current) setIsLoading(false);
    }
  };

  const hasCustomFilters =
    fromOverride !== null || toOverride !== null || methodFilter !== '' || kindFilter !== '';

  const resetFilters = () => {
    invalidateRequests();
    setFromOverride(null);
    setToOverride(null);
    setMethodFilter('');
    setKindFilter('');
    setRows([]);
    setNextCursor(null);
    setIsLoading(true);
    setError(null);
    setRangeResetToken((current) => current + 1);
  };

  const retry = () => {
    invalidateRequests();
    setRows([]);
    setNextCursor(null);
    setIsLoading(true);
    setError(null);
    setReloadToken((current) => current + 1);
  };

  const visibleError = rangeInvalid ? 'Start date must be on or before end date.' : error;
  const visibleRows = rangeInvalid ? [] : rows;
  const visibleSummary = rangeInvalid ? { collected: 0, refunded: 0, net: 0 } : summary;

  const columns = [
    {
      key: 'paymentDate' as const,
      label: 'Date',
      render: (row: PaymentLedgerItemDto) => (
        <span className="font-mono text-ink">{formatDateOnly(row.paymentDate)}</span>
      ),
    },
    {
      key: 'orderNumber' as const,
      label: 'Order',
      render: (row: PaymentLedgerItemDto) => (
        <Link
          className="font-mono font-semibold text-sky-strong hover:underline"
          href={`/orders/${row.orderId}`}
        >
          {row.orderNumber}
        </Link>
      ),
    },
    {
      key: 'customerName' as const,
      label: 'Customer',
      render: (row: PaymentLedgerItemDto) => (
        <span className="font-semibold text-ink">{row.customerName}</span>
      ),
    },
    {
      key: 'kind' as const,
      label: 'Type',
      render: (row: PaymentLedgerItemDto) => {
        const isVoided = row.voidedAt !== null;
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              className={
                isVoided
                  ? 'bg-surface-muted text-muted'
                  : row.kind === 'REFUND'
                    ? 'bg-warning-soft text-warning'
                    : 'bg-success-soft text-success'
              }
            >
              {PAYMENT_KIND_LABEL[row.kind]}
            </Badge>
            {isVoided && <Badge className="bg-danger-soft text-danger">Voided</Badge>}
          </div>
        );
      },
    },
    {
      key: 'method' as const,
      label: 'Method',
      render: (row: PaymentLedgerItemDto) => (
        <span className="text-body">{PAYMENT_METHOD_LABEL[row.method]}</span>
      ),
    },
    {
      key: 'referenceNumber' as const,
      label: 'Reference',
      render: (row: PaymentLedgerItemDto) => (
        <span className="font-mono text-body">{row.referenceNumber ?? '—'}</span>
      ),
    },
    {
      key: 'amount' as const,
      label: 'Amount',
      render: (row: PaymentLedgerItemDto) => {
        const isVoided = row.voidedAt !== null;
        const isRefund = row.kind === 'REFUND';
        return (
          <span
            className={`font-mono font-semibold ${isVoided ? 'line-through text-muted' : isRefund ? 'text-warning' : 'text-ink'}`}
          >
            {isRefund ? '−' : ''}
            {formatMoney(row.amount, currency)}
          </span>
        );
      },
    },
    {
      key: 'recordedByName' as const,
      label: 'Recorded by',
      render: (row: PaymentLedgerItemDto) => (
        <span className="text-body">{row.recordedByName}</span>
      ),
    },
  ];

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
        <header className="grid gap-2">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-sky-strong">
            Money ledger
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-ink">Payments</h1>
          <p className="max-w-2xl text-base leading-7 text-body">
            Review every payment and refund recorded across your orders. Totals below cover the
            entire filtered range and exclude voided entries.
          </p>
        </header>

        <section aria-label="Payment totals" className="grid gap-4 sm:grid-cols-3">
          <Card className="grid gap-1">
            <p className="text-sm font-semibold text-body">Collected</p>
            <p className="font-mono text-2xl font-semibold text-success">
              {formatMoney(visibleSummary.collected, currency)}
            </p>
          </Card>
          <Card className="grid gap-1">
            <p className="text-sm font-semibold text-body">Refunded</p>
            <p className="font-mono text-2xl font-semibold text-warning">
              {formatMoney(visibleSummary.refunded, currency)}
            </p>
          </Card>
          <Card className="grid gap-1">
            <p className="text-sm font-semibold text-body">Net</p>
            <p className="font-mono text-2xl font-semibold text-ink">
              {visibleSummary.net < 0 ? '−' : ''}
              {formatMoney(Math.abs(visibleSummary.net), currency)}
            </p>
          </Card>
        </section>

        <section aria-labelledby="payment-filters-title" className="grid gap-4">
          <h2 className="sr-only" id="payment-filters-title">
            Filter payments
          </h2>

          <FilterBar>
            <div className="grid flex-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field htmlFor="payments-from" label="From date">
                <Input
                  id="payments-from"
                  onChange={(event) => {
                    invalidateRequests();
                    setFromOverride(event.target.value);
                    setRows([]);
                    setNextCursor(null);
                    setIsLoading(true);
                    setError(null);
                  }}
                  type="date"
                  value={effectiveFrom}
                />
              </Field>
              <Field htmlFor="payments-to" label="To date">
                <Input
                  id="payments-to"
                  onChange={(event) => {
                    invalidateRequests();
                    setToOverride(event.target.value);
                    setRows([]);
                    setNextCursor(null);
                    setIsLoading(true);
                    setError(null);
                  }}
                  type="date"
                  value={effectiveTo}
                />
              </Field>
              <Field htmlFor="payments-method" label="Method">
                <Select
                  id="payments-method"
                  onChange={(event) => {
                    invalidateRequests();
                    setMethodFilter(event.target.value as PaymentMethodType | '');
                    setRows([]);
                    setNextCursor(null);
                    setIsLoading(true);
                    setError(null);
                  }}
                  value={methodFilter}
                >
                  <option value="">All methods</option>
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {PAYMENT_METHOD_LABEL[method]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field htmlFor="payments-kind" label="Type">
                <Select
                  id="payments-kind"
                  onChange={(event) => {
                    invalidateRequests();
                    setKindFilter(event.target.value as PaymentKindType | '');
                    setRows([]);
                    setNextCursor(null);
                    setIsLoading(true);
                    setError(null);
                  }}
                  value={kindFilter}
                >
                  <option value="">All types</option>
                  {PAYMENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {PAYMENT_KIND_LABEL[kind]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {hasCustomFilters && (
              <Button onClick={resetFilters} type="button" variant="quiet">
                Reset filters
              </Button>
            )}
          </FilterBar>
        </section>

        {isLoading && visibleRows.length === 0 && !rangeInvalid && (
          <div className="grid gap-3" role="status">
            <span className="sr-only">Loading payments…</span>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {visibleError !== null && (
          <ErrorState onRetry={rangeInvalid ? resetFilters : retry}>{visibleError}</ErrorState>
        )}

        {!isLoading && visibleError === null && visibleRows.length === 0 && (
          <div role="status">
            <EmptyState>
              <div>
                <Wallet aria-hidden="true" className="mx-auto mb-3 text-muted" size={28} />
                <p className="font-semibold text-ink">
                  {hasCustomFilters ? 'No payments match these filters' : 'No payments this month'}
                </p>
                <p className="mt-1 text-sm text-body">
                  {hasCustomFilters
                    ? 'Try widening the date range or clearing the method and type filters.'
                    : 'Payments recorded during order creation or on an order detail page will appear here.'}
                </p>
                {hasCustomFilters && (
                  <Button className="mt-4" onClick={resetFilters} type="button" variant="secondary">
                    Reset filters
                  </Button>
                )}
              </div>
            </EmptyState>
          </div>
        )}

        {visibleRows.length > 0 && (
          <Card className="overflow-hidden p-0">
            <DataTable columns={columns} rows={visibleRows} />
            <div className="grid gap-3 p-4 md:hidden">
              {visibleRows.map((row) => {
                const isVoided = row.voidedAt !== null;
                const isRefund = row.kind === 'REFUND';
                return (
                  <RecordCard key={row.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Link
                          className="font-mono text-sm font-semibold text-sky-strong hover:underline"
                          href={`/orders/${row.orderId}`}
                        >
                          {row.orderNumber}
                        </Link>
                        <h3 className="mt-1 font-semibold text-ink">{row.customerName}</h3>
                      </div>
                      <p
                        className={`font-mono text-base font-semibold ${isVoided ? 'line-through text-muted' : isRefund ? 'text-warning' : 'text-ink'}`}
                      >
                        {isRefund ? '−' : ''}
                        {formatMoney(row.amount, currency)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        className={
                          isVoided
                            ? 'bg-surface-muted text-muted'
                            : isRefund
                              ? 'bg-warning-soft text-warning'
                              : 'bg-success-soft text-success'
                        }
                      >
                        {PAYMENT_KIND_LABEL[row.kind]}
                      </Badge>
                      <Badge className="bg-surface-muted text-body">
                        {PAYMENT_METHOD_LABEL[row.method]}
                      </Badge>
                      {isVoided && <Badge className="bg-danger-soft text-danger">Voided</Badge>}
                    </div>
                    <div className="grid gap-1 border-t border-border pt-3 text-sm text-body">
                      <p>Date: {formatDateOnly(row.paymentDate)}</p>
                      {row.referenceNumber !== null && (
                        <p>
                          Reference: <span className="font-mono">{row.referenceNumber}</span>
                        </p>
                      )}
                      <p className="text-muted">Recorded by {row.recordedByName}</p>
                    </div>
                  </RecordCard>
                );
              })}
            </div>
          </Card>
        )}

        {visibleRows.length > 0 && nextCursor !== null && (
          <div className="flex justify-center">
            <Button
              disabled={isLoading}
              onClick={() => void loadMore()}
              type="button"
              variant="secondary"
            >
              {isLoading ? 'Loading…' : 'Load more payments'}
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
