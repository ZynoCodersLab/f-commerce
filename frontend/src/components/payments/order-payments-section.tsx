'use client';

import { useRef, useState } from 'react';
import { Banknote, Ban, Plus, RotateCcw } from 'lucide-react';
import {
  availablePaymentMethods,
  type OrderDto,
  type PaymentEntryDto,
  type PaymentMethodType,
} from '@f-commerce/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { isTimeoutError } from '@/lib/auth-client';
import { formatDateOnly, formatDateTime, formatMoney } from '@/lib/catalog-format';
import { OrderApiError } from '@/lib/order-client';
import { recordOrderPayment, recordOrderRefund, voidOrderPayment } from '@/lib/payment-client';
import {
  PAYMENT_KIND_LABEL,
  PAYMENT_METHOD_LABEL,
  isCardMethod,
  isOrderClosedForPayment,
  parsePaymentAmountInput,
  paymentReferenceLabel,
} from '@/lib/payment-format';
import { todayInTimeZone } from '@/lib/timezone';
import { PaymentStatusBadge } from './payment-status-badge';

interface OrderPaymentsSectionProps {
  order: OrderDto;
  onOrderUpdated: (order: OrderDto, noticeMessage: string) => void;
  onRefresh: () => Promise<void>;
  onNotice: (message: string, tone: 'success' | 'neutral') => void;
  onActionError: (message: string) => void;
}

type EntryDialogMode = 'payment' | 'refund';

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function PaymentRow({
  entry,
  currency,
  timezone,
  canVoid,
  onRequestVoid,
}: {
  entry: PaymentEntryDto;
  currency: string;
  timezone: string;
  canVoid: boolean;
  onRequestVoid: (entry: PaymentEntryDto) => void;
}) {
  const isVoided = entry.voidedAt !== null;
  const isRefund = entry.kind === 'REFUND';

  return (
    <li
      className={`grid gap-2 border-t border-border py-4 first:border-t-0 first:pt-0 last:pb-0 ${isVoided ? 'opacity-75' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            className={
              isVoided
                ? 'bg-surface-muted text-muted'
                : isRefund
                  ? 'bg-warning-soft text-warning'
                  : 'bg-success-soft text-success'
            }
          >
            {PAYMENT_KIND_LABEL[entry.kind]}
          </Badge>
          <span className="text-sm font-semibold text-ink">
            {PAYMENT_METHOD_LABEL[entry.method]}
          </span>
          {isVoided && <Badge className="bg-danger-soft text-danger">Voided</Badge>}
        </div>
        <div className="flex items-start gap-3">
          <div className="text-right">
            <p
              className={`font-mono text-base font-semibold ${isVoided ? 'line-through text-muted' : isRefund ? 'text-warning' : 'text-ink'}`}
            >
              {isRefund ? '−' : ''}
              {formatMoney(entry.amount, currency)}
            </p>
            {isVoided && <p className="text-xs text-muted">Excluded from totals</p>}
          </div>
          {canVoid && !isVoided && (
            <Button
              aria-label={`Void ${PAYMENT_KIND_LABEL[entry.kind].toLowerCase()} of ${formatMoney(entry.amount, currency)}`}
              className="text-danger hover:bg-danger-soft"
              onClick={() => onRequestVoid(entry)}
              type="button"
              variant="quiet"
            >
              <Ban aria-hidden="true" size={16} />
              Void
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-body">
        <span>Date: {formatDateOnly(entry.paymentDate)}</span>
        <span>Recorded by {entry.recordedByName}</span>
        <span className="text-muted">{formatDateTime(entry.createdAt, timezone)}</span>
      </div>

      {entry.referenceNumber !== null && (
        <p className="text-sm text-body">
          <span className="font-semibold text-ink">Reference:</span>{' '}
          <span className="font-mono">{entry.referenceNumber}</span>
        </p>
      )}

      {entry.notes !== null && (
        <p className="whitespace-pre-line rounded-md bg-surface-muted p-3 text-sm text-ink">
          {entry.notes}
        </p>
      )}

      {isVoided && (
        <p className="rounded-md bg-danger-soft/50 p-3 text-sm text-danger">
          Voided by {entry.voidedByName ?? 'Owner'}
          {entry.voidReason !== null ? `: ${entry.voidReason}` : ''}
        </p>
      )}
    </li>
  );
}

export function OrderPaymentsSection({
  order,
  onOrderUpdated,
  onRefresh,
  onNotice,
  onActionError,
}: OrderPaymentsSectionProps) {
  const { currency, timezone, role, mounted } = useBusinessSettings();

  const [entryDialogMode, setEntryDialogMode] = useState<EntryDialogMode | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodType>('CASH');
  const [referenceInput, setReferenceInput] = useState('');
  const [dateInput, setDateInput] = useState('');
  const [notesInput, setNotesInput] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [voidTarget, setVoidTarget] = useState<PaymentEntryDto | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidFieldError, setVoidFieldError] = useState<string | null>(null);
  const [voidDialogError, setVoidDialogError] = useState<string | null>(null);
  const [isVoiding, setIsVoiding] = useState(false);

  const idempotencyKeyRef = useRef<string>('');
  const allowedMethods = availablePaymentMethods(currency);
  const effectiveMethod: PaymentMethodType = allowedMethods.includes(selectedMethod)
    ? selectedMethod
    : 'CASH';
  const businessToday = mounted ? todayInTimeZone(timezone) : '';

  const isOwner = role === 'OWNER';
  const isClosed = isOrderClosedForPayment(order.status);
  const canRecordPayment = !isClosed && order.dueAmount > 0;
  const canRecordRefund = isOwner && order.paidAmount > 0;

  const openEntryDialog = (mode: EntryDialogMode) => {
    idempotencyKeyRef.current = generateIdempotencyKey();
    if (mode === 'payment') {
      setAmountInput(String(order.dueAmount));
    } else {
      setAmountInput(isClosed && order.refundOwed > 0 ? String(order.refundOwed) : '');
    }
    setSelectedMethod('CASH');
    setReferenceInput('');
    setDateInput(mounted ? todayInTimeZone(timezone) : '');
    setNotesInput('');
    setFieldError(null);
    setDialogError(null);
    setEntryDialogMode(mode);
  };

  const openVoidDialog = (entry: PaymentEntryDto) => {
    setVoidTarget(entry);
    setVoidReason('');
    setVoidFieldError(null);
    setVoidDialogError(null);
  };

  const handleEntrySubmit = async () => {
    if (entryDialogMode === null) return;
    setFieldError(null);
    setDialogError(null);

    const parsedAmount = parsePaymentAmountInput(amountInput);
    if (parsedAmount === null) {
      setFieldError('Enter a whole amount of at least 1.');
      return;
    }

    if (entryDialogMode === 'payment' && parsedAmount > order.dueAmount) {
      setFieldError(
        `Amount cannot exceed the current due of ${formatMoney(order.dueAmount, currency)}.`,
      );
      return;
    }
    if (entryDialogMode === 'refund' && parsedAmount > order.paidAmount) {
      setFieldError(
        `Amount cannot exceed the current paid amount of ${formatMoney(order.paidAmount, currency)}.`,
      );
      return;
    }

    const trimmedDate = dateInput.trim();
    if (trimmedDate !== '' && businessToday !== '' && trimmedDate > businessToday) {
      setDialogError('Payment date cannot be in the future.');
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        amount: parsedAmount,
        method: effectiveMethod,
        paymentDate: trimmedDate === '' ? null : trimmedDate,
        referenceNumber: referenceInput.trim() === '' ? null : referenceInput.trim(),
        notes: notesInput.trim() === '' ? null : notesInput.trim(),
      };
      const updated =
        entryDialogMode === 'payment'
          ? await recordOrderPayment(order.id, payload, idempotencyKeyRef.current)
          : await recordOrderRefund(order.id, payload, idempotencyKeyRef.current);

      const message = entryDialogMode === 'payment' ? 'Payment recorded.' : 'Refund recorded.';
      setEntryDialogMode(null);
      onOrderUpdated(updated, message);
    } catch (err) {
      if (err instanceof OrderApiError) {
        if (err.status === 409) {
          await onRefresh();
          if (err.code === 'ORDER_CLOSED') {
            setEntryDialogMode(null);
            onActionError(err.message);
            return;
          }
          if (err.code === 'PAYMENT_EXCEEDS_DUE' && err.body.dueAmount !== undefined) {
            setDialogError(
              `${err.message}. Current due is ${formatMoney(err.body.dueAmount, currency)}.`,
            );
            return;
          }
          if (err.code === 'REFUND_EXCEEDS_PAID' && err.body.paidAmount !== undefined) {
            setDialogError(
              `${err.message}. Current paid amount is ${formatMoney(err.body.paidAmount, currency)}.`,
            );
            return;
          }
          setDialogError(err.message);
          return;
        }
        setDialogError(err.message);
        return;
      }
      if (isTimeoutError(err)) {
        setEntryDialogMode(null);
        await onRefresh();
        onNotice(
          'That request took too long. The order was reloaded to show its current payments.',
          'neutral',
        );
        return;
      }
      setDialogError(err instanceof Error ? err.message : 'Could not save entry.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVoidSubmit = async () => {
    if (voidTarget === null) return;
    setVoidFieldError(null);
    setVoidDialogError(null);

    const trimmedReason = voidReason.trim();
    if (trimmedReason.length === 0) {
      setVoidFieldError('Enter a reason for voiding this entry.');
      return;
    }
    if (trimmedReason.length > 200) {
      setVoidFieldError('Keep the reason to 200 characters or fewer.');
      return;
    }

    setIsVoiding(true);
    try {
      const updated = await voidOrderPayment(order.id, voidTarget.id, { reason: trimmedReason });
      setVoidTarget(null);
      setVoidReason('');
      onOrderUpdated(updated, 'Entry voided.');
    } catch (err) {
      if (err instanceof OrderApiError) {
        if (err.status === 409) {
          await onRefresh();
          if (err.code === 'PAYMENT_ALREADY_VOIDED') {
            setVoidTarget(null);
            onActionError(err.message);
            return;
          }
          if (err.code === 'VOID_BREAKS_BALANCE') {
            setVoidDialogError(err.message);
            return;
          }
          setVoidDialogError(err.message);
          return;
        }
        setVoidDialogError(err.message);
        return;
      }
      if (isTimeoutError(err)) {
        setVoidTarget(null);
        await onRefresh();
        onNotice(
          'That request took too long. The order was reloaded to show its current payments.',
          'neutral',
        );
        return;
      }
      setVoidDialogError(err instanceof Error ? err.message : 'Could not void entry.');
    } finally {
      setIsVoiding(false);
    }
  };

  const entryDialogTitle = entryDialogMode === 'refund' ? 'Record refund' : 'Record payment';
  const entryDialogDescription =
    entryDialogMode === 'refund'
      ? isClosed && order.refundOwed > 0
        ? `Refund owed on ${order.orderNumber}: ${formatMoney(order.refundOwed, currency)}.`
        : `Paid amount on ${order.orderNumber}: ${formatMoney(order.paidAmount, currency)}.`
      : `Remaining due on ${order.orderNumber}: ${formatMoney(order.dueAmount, currency)}.`;

  return (
    <section aria-labelledby="payments-title" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold text-ink" id="payments-title">
              Payments
            </h2>
            <PaymentStatusBadge status={order.paymentStatus} />
          </div>
          <p className="mt-1 text-sm text-body">
            Every payment and refund entry is kept, oldest first.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canRecordPayment && (
            <Button onClick={() => openEntryDialog('payment')} type="button" variant="primary">
              <Plus aria-hidden="true" size={16} />
              Record payment
            </Button>
          )}
          {canRecordRefund && (
            <Button onClick={() => openEntryDialog('refund')} type="button" variant="secondary">
              <RotateCcw aria-hidden="true" size={16} />
              Record refund
            </Button>
          )}
        </div>
      </div>

      <Card>
        {order.payments.length === 0 ? (
          <div className="flex flex-col items-start gap-2 py-2 text-sm text-body">
            <div className="flex items-center gap-2 font-semibold text-ink">
              <Banknote aria-hidden="true" size={16} />
              <span>No payments recorded yet</span>
            </div>
            <p>
              {canRecordPayment
                ? 'Use Record payment when the buyer sends an advance or settles the balance.'
                : 'No money entries were recorded for this order.'}
            </p>
          </div>
        ) : (
          <ol className="grid">
            {order.payments.map((entry) => (
              <PaymentRow
                canVoid={isOwner}
                currency={currency}
                entry={entry}
                key={entry.id}
                onRequestVoid={openVoidDialog}
                timezone={timezone}
              />
            ))}
          </ol>
        )}
      </Card>

      <Dialog
        description={entryDialogDescription}
        onClose={() => {
          if (!isSubmitting) setEntryDialogMode(null);
        }}
        open={entryDialogMode !== null}
        title={entryDialogTitle}
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleEntrySubmit();
          }}
        >
          {dialogError !== null && <Alert variant="danger">{dialogError}</Alert>}

          <Field
            description={`Whole units in ${currency || 'business currency'}.`}
            error={fieldError ?? undefined}
            htmlFor="record-payment-amount"
            label="Amount"
          >
            <Input
              aria-invalid={fieldError !== null ? true : undefined}
              disabled={isSubmitting}
              id="record-payment-amount"
              inputMode="numeric"
              min={1}
              onChange={(event) => {
                setAmountInput(event.target.value);
                setFieldError(null);
              }}
              required
              type="number"
              value={amountInput}
            />
          </Field>

          <Field htmlFor="record-payment-method" label="Payment method">
            <Select
              disabled={isSubmitting}
              id="record-payment-method"
              onChange={(event) => setSelectedMethod(event.target.value as PaymentMethodType)}
              value={effectiveMethod}
            >
              {allowedMethods.map((method) => (
                <option key={method} value={method}>
                  {PAYMENT_METHOD_LABEL[method]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            description={
              isCardMethod(effectiveMethod)
                ? 'Never enter a full card number. Store only the receipt or transaction reference.'
                : undefined
            }
            htmlFor="record-payment-reference"
            label={paymentReferenceLabel(effectiveMethod)}
          >
            <Input
              disabled={isSubmitting}
              id="record-payment-reference"
              maxLength={100}
              onChange={(event) => setReferenceInput(event.target.value)}
              type="text"
              value={referenceInput}
            />
          </Field>

          <Field
            description="Defaults to the business's today. Past dates are allowed."
            htmlFor="record-payment-date"
            label="Payment date"
          >
            <Input
              disabled={isSubmitting}
              id="record-payment-date"
              max={businessToday || undefined}
              onChange={(event) => setDateInput(event.target.value)}
              type="date"
              value={dateInput}
            />
          </Field>

          <Field htmlFor="record-payment-notes" label="Notes (optional)">
            <Textarea
              disabled={isSubmitting}
              id="record-payment-notes"
              maxLength={500}
              onChange={(event) => setNotesInput(event.target.value)}
              value={notesInput}
            />
          </Field>

          <div className="flex flex-wrap gap-3">
            <Button disabled={isSubmitting} type="submit" variant="primary">
              {isSubmitting
                ? 'Saving…'
                : entryDialogMode === 'refund'
                  ? 'Save refund'
                  : 'Save payment'}
            </Button>
            <Button
              disabled={isSubmitting}
              onClick={() => setEntryDialogMode(null)}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        description={
          voidTarget !== null
            ? `${PAYMENT_METHOD_LABEL[voidTarget.method]} · ${formatMoney(voidTarget.amount, currency)} on ${formatDateOnly(voidTarget.paymentDate)}. Voiding cannot be undone.`
            : undefined
        }
        onClose={() => {
          if (!isVoiding) setVoidTarget(null);
        }}
        open={voidTarget !== null}
        title={
          voidTarget !== null
            ? `Void this ${voidTarget.kind === 'REFUND' ? 'refund' : 'payment'}?`
            : 'Void entry'
        }
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleVoidSubmit();
          }}
        >
          {voidDialogError !== null && <Alert variant="danger">{voidDialogError}</Alert>}

          <Field
            description="Required. Shown beside the voided entry and recorded in the audit log."
            error={voidFieldError ?? undefined}
            htmlFor="void-payment-reason"
            label="Reason"
          >
            <Textarea
              aria-invalid={voidFieldError !== null ? true : undefined}
              disabled={isVoiding}
              id="void-payment-reason"
              maxLength={200}
              onChange={(event) => {
                setVoidReason(event.target.value);
                setVoidFieldError(null);
              }}
              required
              value={voidReason}
            />
          </Field>

          <div className="flex flex-wrap gap-3">
            <Button disabled={isVoiding} type="submit" variant="danger">
              {isVoiding ? 'Voiding…' : 'Void entry'}
            </Button>
            <Button
              disabled={isVoiding}
              onClick={() => setVoidTarget(null)}
              type="button"
              variant="secondary"
            >
              Keep entry
            </Button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
