'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Pencil, Phone } from 'lucide-react';
import type { OrderDto, OrderItemDto, OrderStatusType } from '@f-commerce/contracts';
import { AppShell } from '@/components/shell/shell';
import {
  Alert,
  Button,
  Card,
  DataTable,
  Dialog,
  ErrorState,
  Field,
  RecordCard,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { OrderForm } from '@/components/orders/order-form';
import { OrderStatusBadge } from '@/components/orders/order-status';
import { OrderPaymentsSection } from '@/components/payments/order-payments-section';
import { PaymentStatusBadge } from '@/components/payments/payment-status-badge';
import { isTimeoutError } from '@/lib/auth-client';
import { useRequireAuth } from '@/lib/auth-guard';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { formatDateTime, formatMoney } from '@/lib/catalog-format';
import { OrderDeadlineSummary } from '@/components/orders/order-deadline';
import { OrderApiError, changeOrderStatus, getOrder } from '@/lib/order-client';
import {
  ORDER_STATUS_LABEL,
  isOrderEditable,
  nextOrderStatuses,
  orderSourceLabel,
} from '@/lib/order-form';

interface Notice {
  message: string;
  tone: 'success' | 'neutral';
}

function statusActionLabel(status: OrderStatusType): string {
  switch (status) {
    case 'CONFIRMED':
      return 'Confirm order';
    case 'PROCESSING':
      return 'Start processing';
    case 'SHIPPED':
      return 'Mark shipped';
    case 'DELIVERED':
      return 'Mark delivered';
    case 'CANCELLED':
      return 'Cancel order';
    case 'RETURNED':
      return 'Mark returned';
    case 'PENDING':
      return 'Return to pending';
  }
}

function statusDialogTitle(status: OrderStatusType): string {
  if (status === 'CANCELLED') return 'Cancel this order?';
  if (status === 'RETURNED') return 'Mark this order as returned?';
  return `Mark as ${ORDER_STATUS_LABEL[status].toLowerCase()}?`;
}

export default function OrderDetailPage() {
  const ready = useRequireAuth();
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const { currency, timezone } = useBusinessSettings();

  const [order, setOrder] = useState<OrderDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const [statusTarget, setStatusTarget] = useState<OrderStatusType | null>(null);
  const [statusNote, setStatusNote] = useState('');
  const [isChangingStatus, setIsChangingStatus] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getOrder(orderId)
      .then((nextOrder) => {
        if (cancelled) return;
        setOrder(nextOrder);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'The order could not be loaded');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setOrder(await getOrder(orderId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The order could not be loaded');
    }
  }, [orderId]);

  const submitStatus = async () => {
    if (order === null || statusTarget === null) return;
    setIsChangingStatus(true);
    setActionError(null);

    try {
      const updated = await changeOrderStatus(order.id, {
        status: statusTarget,
        version: order.version,
        note: statusNote.trim() === '' ? null : statusNote,
      });
      setOrder(updated);
      setStatusTarget(null);
      setStatusNote('');
      setNotice({
        message: `Order moved to ${ORDER_STATUS_LABEL[updated.status]}.`,
        tone: 'success',
      });
    } catch (err) {
      if (err instanceof OrderApiError) {
        if (err.code === 'ORDER_CHANGED' || err.code === 'INVALID_STATUS_TRANSITION') {
          setStatusTarget(null);
          await reload();
          setNotice({
            message: 'This order changed elsewhere. The newest state is shown.',
            tone: 'neutral',
          });
          return;
        }
        setActionError(err.message);
        return;
      }
      if (isTimeoutError(err)) {
        setStatusTarget(null);
        await reload();
        setNotice({
          message: 'That request took too long. The order was reloaded to show its current state.',
          tone: 'neutral',
        });
        return;
      }
      setActionError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsChangingStatus(false);
    }
  };

  const itemColumns = [
    {
      key: 'productName' as const,
      label: 'Item',
      render: (row: OrderItemDto) => (
        <div>
          <p className="font-semibold text-ink">{row.productName}</p>
          {row.variantLabel !== null && (
            <p className="mt-1 text-sm text-body">{row.variantLabel}</p>
          )}
        </div>
      ),
    },
    {
      key: 'quantity' as const,
      label: 'Qty',
      render: (row: OrderItemDto) => <span className="font-mono text-ink">{row.quantity}</span>,
    },
    {
      key: 'price' as const,
      label: 'Unit price',
      render: (row: OrderItemDto) => (
        <span className="font-mono text-ink">{formatMoney(row.price, currency)}</span>
      ),
    },
    {
      key: 'subtotal' as const,
      label: 'Line total',
      render: (row: OrderItemDto) => (
        <span className="font-mono text-ink">{formatMoney(row.subtotal, currency)}</span>
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
      <div className="grid gap-6">
        <Link
          className="inline-flex min-h-11 w-fit items-center gap-2 text-sm font-semibold text-sky-strong hover:underline"
          href="/orders"
        >
          <ArrowLeft aria-hidden="true" size={16} />
          Back to orders
        </Link>

        {isLoading && <Skeleton className="h-64 w-full" />}

        {!isLoading && error !== null && (
          <ErrorState onRetry={() => void reload()}>{error}</ErrorState>
        )}

        {!isLoading && error === null && order !== null && (
          <>
            <header className="grid gap-4 sm:flex sm:flex-wrap sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="font-mono text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
                    {order.orderNumber}
                  </h1>
                  <OrderStatusBadge status={order.status} />
                  <PaymentStatusBadge status={order.paymentStatus} />
                </div>
                <p className="mt-2 text-sm text-body">
                  {orderSourceLabel(order.source)} · Placed{' '}
                  {formatDateTime(order.createdAt, timezone)}
                </p>
              </div>
              {!editOpen && isOrderEditable(order.status) && (
                <Button onClick={() => setEditOpen(true)} type="button" variant="secondary">
                  <Pencil aria-hidden="true" size={16} />
                  Edit order
                </Button>
              )}
            </header>

            {notice !== null && (
              <Alert variant={notice.tone === 'success' ? 'success' : 'neutral'}>
                <div className="flex items-center justify-between gap-4">
                  <span>{notice.message}</span>
                  <Button onClick={() => setNotice(null)} type="button" variant="quiet">
                    Dismiss
                  </Button>
                </div>
              </Alert>
            )}

            {actionError !== null && (
              <Alert variant="danger">
                <div className="flex items-center justify-between gap-4">
                  <span>{actionError}</span>
                  <Button onClick={() => setActionError(null)} type="button" variant="quiet">
                    Dismiss
                  </Button>
                </div>
              </Alert>
            )}

            {editOpen ? (
              <section aria-labelledby="edit-order-heading" className="grid gap-4">
                <div>
                  <p className="font-mono text-xs uppercase tracking-[0.18em] text-sky-strong">
                    Edit in place
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold text-ink" id="edit-order-heading">
                    Edit {order.orderNumber}
                  </h2>
                </div>
                <OrderForm
                  currency={currency}
                  mode="edit"
                  onCancel={() => setEditOpen(false)}
                  onConflict={() => {
                    setEditOpen(false);
                    void reload();
                    setNotice({
                      message: 'This order changed elsewhere. The newest details are shown.',
                      tone: 'neutral',
                    });
                  }}
                  onSaved={(updated) => {
                    setOrder(updated);
                    setEditOpen(false);
                    setNotice({ message: 'Order updated.', tone: 'success' });
                  }}
                  order={order}
                />
              </section>
            ) : (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
                <div className="grid gap-6">
                  <Card className="grid gap-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="text-xl font-semibold text-ink">Customer</h2>
                        <p className="mt-1 text-body">{order.customerName}</p>
                      </div>
                      <a
                        className="inline-flex min-h-11 items-center gap-2 font-mono text-sm text-sky-strong hover:underline"
                        href={`tel:${order.customerPhone}`}
                      >
                        <Phone aria-hidden="true" size={16} />
                        {order.customerPhone}
                      </a>
                    </div>
                    <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
                      <div>
                        <dt className="text-sm font-semibold text-body">Shipping address</dt>
                        <dd className="mt-1 whitespace-pre-line text-ink">
                          {order.shippingAddress ?? 'Not provided'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-sm font-semibold text-body">Delivery deadline</dt>
                        <dd className="mt-1">
                          <OrderDeadlineSummary order={order} />
                        </dd>
                      </div>
                      <div>
                        <dt className="text-sm font-semibold text-body">Notes</dt>
                        <dd className="mt-1 whitespace-pre-line text-ink">
                          {order.notes ?? 'No notes'}
                        </dd>
                      </div>
                    </dl>
                  </Card>

                  <section aria-labelledby="order-items-title" className="grid gap-4">
                    <h2 className="text-xl font-semibold text-ink" id="order-items-title">
                      Items
                    </h2>
                    <Card className="overflow-hidden p-0">
                      <DataTable columns={itemColumns} rows={order.items} />
                      <div className="grid gap-3 p-4 md:hidden">
                        {order.items.map((item) => (
                          <RecordCard key={item.id}>
                            <div>
                              <p className="font-semibold text-ink">{item.productName}</p>
                              {item.variantLabel !== null && (
                                <p className="mt-1 text-sm text-body">{item.variantLabel}</p>
                              )}
                            </div>
                            <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
                              <span className="text-body">
                                {item.quantity} × {formatMoney(item.price, currency)}
                              </span>
                              <span className="font-mono font-semibold text-ink">
                                {formatMoney(item.subtotal, currency)}
                              </span>
                            </div>
                          </RecordCard>
                        ))}
                      </div>
                    </Card>
                  </section>

                  <OrderPaymentsSection
                    onActionError={(message) => setActionError(message)}
                    onNotice={(message, tone) => setNotice({ message, tone })}
                    onOrderUpdated={(updated, message) => {
                      setOrder(updated);
                      setActionError(null);
                      setNotice({ message, tone: 'success' });
                    }}
                    onRefresh={reload}
                    order={order}
                  />

                  <section aria-labelledby="timeline-title" className="grid gap-4">
                    <div>
                      <h2 className="text-xl font-semibold text-ink" id="timeline-title">
                        Status timeline
                      </h2>
                      <p className="mt-1 text-sm text-body">
                        Every status change is kept, oldest first.
                      </p>
                    </div>
                    <Card>
                      <ol className="grid gap-5">
                        {order.history.map((entry) => (
                          <li className="grid grid-cols-[auto_1fr] gap-3" key={entry.id}>
                            <span
                              aria-hidden="true"
                              className="mt-1 size-3 rounded-full border-2 border-sky bg-surface"
                            />
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <OrderStatusBadge status={entry.toStatus} />
                                <span className="text-sm text-muted">
                                  {formatDateTime(entry.createdAt, timezone)}
                                </span>
                              </div>
                              <p className="mt-2 text-sm text-body">
                                {entry.fromStatus === null
                                  ? `Created as ${ORDER_STATUS_LABEL[entry.toStatus]}`
                                  : `Moved from ${ORDER_STATUS_LABEL[entry.fromStatus]} to ${ORDER_STATUS_LABEL[entry.toStatus]}`}
                              </p>
                              <p className="mt-1 text-sm text-muted">by {entry.changedByName}</p>
                              {entry.note !== null && (
                                <p className="mt-2 whitespace-pre-line rounded-md bg-surface-muted p-3 text-sm text-ink">
                                  {entry.note}
                                </p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    </Card>
                  </section>
                </div>

                <aside className="grid gap-4 lg:sticky lg:top-24">
                  <Card className="grid gap-4">
                    <h2 className="text-xl font-semibold text-ink">Totals</h2>
                    <dl className="grid gap-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-body">Subtotal</dt>
                        <dd className="font-mono text-ink">
                          {formatMoney(order.subtotal, currency)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-body">Delivery</dt>
                        <dd className="font-mono text-ink">
                          {formatMoney(order.deliveryFee, currency)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-body">Discount</dt>
                        <dd className="font-mono text-ink">
                          −{formatMoney(order.discount, currency)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-base">
                        <dt className="font-semibold text-ink">Total</dt>
                        <dd className="font-mono font-semibold text-ink">
                          {formatMoney(order.total, currency)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-body">Paid</dt>
                        <dd className="font-mono text-ink">
                          {formatMoney(order.paidAmount, currency)}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="font-semibold text-ink">Due</dt>
                        <dd className="font-mono font-semibold text-ink">
                          {formatMoney(order.dueAmount, currency)}
                        </dd>
                      </div>
                      {order.refundOwed > 0 && (
                        <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-danger">
                          <dt className="font-semibold">Refund owed</dt>
                          <dd className="font-mono font-semibold">
                            {formatMoney(order.refundOwed, currency)}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </Card>

                  <Card className="grid gap-4">
                    <div>
                      <h2 className="text-xl font-semibold text-ink">Next step</h2>
                      <p className="mt-1 text-sm text-body">
                        Only moves allowed by the workflow appear here.
                      </p>
                    </div>

                    {nextOrderStatuses(order.status).length === 0 ? (
                      <p className="text-sm text-body">
                        This order is closed. No further status changes are possible.
                      </p>
                    ) : (
                      <div className="grid gap-3">
                        {nextOrderStatuses(order.status).map((status) => (
                          <Button
                            key={status}
                            onClick={() => {
                              setStatusNote('');
                              setActionError(null);
                              setStatusTarget(status);
                            }}
                            type="button"
                            variant={
                              status === 'CANCELLED'
                                ? 'danger'
                                : status === 'RETURNED'
                                  ? 'secondary'
                                  : 'primary'
                            }
                          >
                            {statusActionLabel(status)}
                          </Button>
                        ))}
                      </div>
                    )}
                  </Card>
                </aside>
              </div>
            )}

            <Dialog
              description={
                statusTarget !== null
                  ? `This moves ${order.orderNumber} from ${ORDER_STATUS_LABEL[order.status]} to ${ORDER_STATUS_LABEL[statusTarget]}.`
                  : undefined
              }
              onClose={() => {
                if (!isChangingStatus) setStatusTarget(null);
              }}
              open={statusTarget !== null}
              title={statusTarget !== null ? statusDialogTitle(statusTarget) : 'Change status'}
            >
              <div className="grid gap-4">
                <Field
                  description="Optional. It appears on the timeline with this change."
                  htmlFor="status-note"
                  label="Note"
                >
                  <Textarea
                    disabled={isChangingStatus}
                    id="status-note"
                    maxLength={200}
                    onChange={(event) => setStatusNote(event.target.value)}
                    value={statusNote}
                  />
                </Field>
                <div className="flex flex-wrap gap-3">
                  <Button
                    disabled={isChangingStatus}
                    onClick={() => void submitStatus()}
                    type="button"
                    variant={statusTarget === 'CANCELLED' ? 'danger' : 'primary'}
                  >
                    {isChangingStatus
                      ? 'Updating…'
                      : statusActionLabel(statusTarget ?? order.status)}
                  </Button>
                  <Button
                    disabled={isChangingStatus}
                    onClick={() => setStatusTarget(null)}
                    type="button"
                    variant="secondary"
                  >
                    Keep as {ORDER_STATUS_LABEL[order.status].toLowerCase()}
                  </Button>
                </div>
              </div>
            </Dialog>
          </>
        )}
      </div>
    </AppShell>
  );
}
