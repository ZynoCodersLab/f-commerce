'use client';

import { useRef, useState } from 'react';
import NextLink from 'next/link';
import { Trash2 } from 'lucide-react';
import type {
  DuplicateOrderExisting,
  OrderCreateRequest,
  OrderDto,
  OrderSourceType,
  OrderUpdateRequest,
  PaymentMethodType,
  ProductDto,
} from '@f-commerce/contracts';
import {
  ORDER_SOURCES,
  OrderCreateSchema,
  OrderUpdateSchema,
  availablePaymentMethods,
} from '@f-commerce/contracts';
import {
  Alert,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
} from '@/components/ui/primitives';
import { CustomerPicker } from '@/components/orders/customer-picker';
import { ProductPicker } from '@/components/orders/product-picker';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { isTimeoutError } from '@/lib/auth-client';
import { formatDateTime, formatMoney } from '@/lib/catalog-format';
import { todayInTimeZone } from '@/lib/timezone';
import { OrderApiError, createOrder, updateOrder } from '@/lib/order-client';
import {
  PAYMENT_METHOD_LABEL,
  isCardMethod,
  parsePaymentAmountInput,
  paymentReferenceLabel,
} from '@/lib/payment-format';
import {
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  ORDER_SOURCE_LABEL,
  computeOrderTotals,
  effectiveLinePrice,
  lineSubtotal,
  parseMoneyInput,
  parseQuantityInput,
  variantLabel,
  type OrderCustomerSelection,
  type OrderLineState,
  type OrderLineVariant,
} from '@/lib/order-form';

interface OrderFormProps {
  mode: 'create' | 'edit';
  order?: OrderDto;
  currency: string;
  onSaved: (order: OrderDto) => void;
  onCancel?: () => void;
  /** Called when the server reports a stale version or a locked order. */
  onConflict?: () => void;
}

const FIELD_MESSAGES: Record<string, string> = {
  customerId: 'Choose an active customer.',
  items: 'Add at least one product line with a valid quantity and price.',
  source: 'Choose a source channel.',
  deliveryFee: 'Enter a whole amount from 0 to 100,000,000.',
  discount: 'Enter a whole amount from 0 to 100,000,000.',
  shippingAddress: 'Keep the address to 500 characters or fewer.',
  notes: 'Keep notes to 500 characters or fewer.',
  deliveryDeadline: 'Enter a real calendar date.',
  total: 'The order total is above the allowed limit.',
  'initialPayment.amount': 'Enter a whole amount from 1 up to the order total.',
  'initialPayment.method': 'Choose a payment method available for this business currency.',
  'initialPayment.paymentDate': 'Enter a real calendar date on or before today.',
  'initialPayment.referenceNumber': 'Keep the reference to 100 characters or fewer.',
  'initialPayment.notes': 'Keep payment notes to 500 characters or fewer.',
};

function initialLines(order: OrderDto | undefined): OrderLineState[] {
  if (!order) return [];
  return order.items.map((item) => ({
    key: `line-${item.id}`,
    lineId: item.id,
    productId: item.productId,
    variantId: item.variantId,
    productName: item.productName,
    variantLabel: item.variantLabel,
    quantity: String(item.quantity),
    unitPrice: String(item.price),
    productPrice: item.price,
    defaultPrice: item.price,
    variants: [],
  }));
}

function initialCustomer(order: OrderDto | undefined): OrderCustomerSelection | null {
  if (!order || order.customerId === null) return null;
  return {
    id: order.customerId,
    name: order.customerName,
    phone: order.customerPhone,
    address: null,
  };
}

function fieldsFromIssues(issues: { path: PropertyKey[] }[]): string[] {
  return Array.from(
    new Set(
      issues
        .map((issue) => {
          const first = String(issue.path[0] ?? '');
          if (first === 'initialPayment' && issue.path.length > 1) {
            return `${first}.${String(issue.path[1])}`;
          }
          return first;
        })
        .filter((field) => field !== ''),
    ),
  );
}

function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `order-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A native date input yields `YYYY-MM-DD`, so the day is kept as text and
 * checked against the month lengths. This rejects `2026-02-30` and
 * `2026-13-01` without turning the value into a `Date`.
 */
function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/** Shared create and edit form. The page owns the heading and navigation. */
export function OrderForm({
  mode,
  order,
  currency,
  onSaved,
  onCancel,
  onConflict,
}: OrderFormProps) {
  const { timezone, mounted } = useBusinessSettings();
  const [customer, setCustomer] = useState<OrderCustomerSelection | null>(() =>
    initialCustomer(order),
  );
  const [lines, setLines] = useState<OrderLineState[]>(() => initialLines(order));
  const [source, setSource] = useState<OrderSourceType>(order?.source ?? 'DIRECT');
  const [deliveryFee, setDeliveryFee] = useState(order ? String(order.deliveryFee) : '');
  const [discount, setDiscount] = useState(order ? String(order.discount) : '');
  const [shippingAddress, setShippingAddress] = useState(order?.shippingAddress ?? '');
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [deliveryDeadline, setDeliveryDeadline] = useState(order?.deliveryDeadline ?? '');

  // Create only optional first payment state.
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType>('CASH');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentDateOverride, setPaymentDateOverride] = useState<string | null>(null);
  const [paymentNotes, setPaymentNotes] = useState('');

  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateOrderExisting | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const nextLineKey = useRef(1);
  const idempotencyKey = useRef('');

  const totals = computeOrderTotals(lines, deliveryFee, discount);
  const discountTooHigh = totals.discount > totals.subtotal + totals.deliveryFee;
  // The business day is unknown on the server and the hydration render, so the
  // warning waits for the client clock rather than guessing a day.
  const today = mounted ? todayInTimeZone(timezone) : null;
  const deadlineInPast =
    today !== null &&
    deliveryDeadline !== '' &&
    isRealCalendarDate(deliveryDeadline) &&
    deliveryDeadline < today;

  const allowedPaymentMethods = availablePaymentMethods(currency);
  const effectivePaymentMethod: PaymentMethodType = allowedPaymentMethods.includes(paymentMethod)
    ? paymentMethod
    : 'CASH';
  const effectivePaymentDate = paymentDateOverride ?? today ?? '';
  const hasInitialPayment = mode === 'create' && paymentAmount.trim() !== '';
  const parsedPaymentAmount = hasInitialPayment ? parsePaymentAmountInput(paymentAmount) : null;
  const paymentAmountAboveTotal =
    hasInitialPayment &&
    parsedPaymentAmount !== null &&
    totals.total >= 0 &&
    parsedPaymentAmount > totals.total;

  const fieldError = (field: string): string | undefined =>
    fieldErrors.includes(field) ? FIELD_MESSAGES[field] : undefined;

  const updateLine = (key: string, patch: Partial<OrderLineState>) => {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  };

  const pairExists = (productId: string, variantId: string | null): boolean =>
    lines.some((line) => line.productId === productId && line.variantId === variantId);

  const handleAddProduct = (product: ProductDto): boolean => {
    const optionNames = product.options.map((option) => option.name);
    const variants: OrderLineVariant[] = product.variants.flatMap((variant) =>
      variant.id
        ? [
            {
              id: variant.id,
              label: variantLabel(optionNames, variant.combination) ?? 'Variant',
              price: variant.price,
            },
          ]
        : [],
    );

    let chosen: OrderLineVariant | null = null;
    if (variants.length > 0) {
      chosen = variants.find((variant) => !pairExists(product.id, variant.id)) ?? null;
      if (chosen === null) return false;
    } else if (pairExists(product.id, null)) {
      return false;
    }

    setLines((current) => [
      ...current,
      {
        key: `new-${nextLineKey.current++}`,
        productId: product.id,
        variantId: chosen?.id ?? null,
        productName: product.name,
        variantLabel: chosen?.label ?? null,
        quantity: '1',
        unitPrice: '',
        productPrice: product.price,
        defaultPrice: chosen?.price ?? product.price,
        variants,
      },
    ]);
    return true;
  };

  const applyIssues = (issues: { path: PropertyKey[] }[]) => {
    setFieldErrors(fieldsFromIssues(issues));
    setFormError('Check the highlighted fields.');
  };

  const submit = async (confirmDuplicate: boolean) => {
    setFieldErrors([]);
    setFormError(null);
    setDuplicate(null);

    const parsedLines = lines.map((line) => ({
      line,
      quantity: parseQuantityInput(line.quantity),
      price: effectiveLinePrice(line),
    }));
    const errors: string[] = [];

    if (customer === null) errors.push('customerId');
    if (lines.length === 0 || lines.length > MAX_ORDER_LINES) errors.push('items');
    if (parsedLines.some((entry) => entry.quantity === null || entry.price === null)) {
      errors.push('items');
    }

    const deliveryFeeValue = parseMoneyInput(deliveryFee, true);
    if (deliveryFeeValue === null) errors.push('deliveryFee');
    const discountValue = parseMoneyInput(discount, true);
    if (discountValue === null) errors.push('discount');
    if (shippingAddress.length > 500) errors.push('shippingAddress');
    if (notes.length > 500) errors.push('notes');
    if (deliveryDeadline !== '' && !isRealCalendarDate(deliveryDeadline)) {
      errors.push('deliveryDeadline');
    }

    const preview = computeOrderTotals(lines, deliveryFee, discount);
    if (
      deliveryFeeValue !== null &&
      discountValue !== null &&
      discountValue > preview.subtotal + deliveryFeeValue
    ) {
      errors.push('discount');
    }
    if (preview.subtotal > 2_000_000_000 || preview.total > 2_000_000_000) {
      errors.push('total');
    }

    let initialPaymentInput: OrderCreateRequest['initialPayment'] = null;
    if (mode === 'create' && paymentAmount.trim() !== '') {
      const amount = parsePaymentAmountInput(paymentAmount);
      if (amount === null || amount > preview.total) {
        errors.push('initialPayment.amount');
      }
      const trimmedDate = effectivePaymentDate.trim();
      if (trimmedDate !== '') {
        if (!isRealCalendarDate(trimmedDate) || (today !== null && trimmedDate > today)) {
          errors.push('initialPayment.paymentDate');
        }
      }
      if (paymentReference.trim().length > 100) {
        errors.push('initialPayment.referenceNumber');
      }
      if (paymentNotes.trim().length > 500) {
        errors.push('initialPayment.notes');
      }
      if (amount !== null) {
        initialPaymentInput = {
          amount,
          method: effectivePaymentMethod,
          paymentDate: trimmedDate === '' ? null : trimmedDate,
          referenceNumber: paymentReference.trim() === '' ? null : paymentReference.trim(),
          notes: paymentNotes.trim() === '' ? null : paymentNotes.trim(),
        };
      }
    }

    if (errors.length > 0) {
      setFieldErrors(Array.from(new Set(errors)));
      setFormError('Check the highlighted fields.');
      return;
    }

    if (customer === null) return;

    const items = parsedLines.flatMap(({ line, quantity, price }) => {
      if (quantity === null || price === null) return [];
      return [
        {
          productId: line.productId,
          variantId: line.variantId,
          quantity,
          ...(line.unitPrice.trim() === '' ? {} : { unitPrice: price }),
        },
      ];
    });

    let run: () => Promise<OrderDto>;

    if (mode === 'create') {
      const parsed = OrderCreateSchema.safeParse({
        customerId: customer.id,
        items,
        source,
        deliveryFee: deliveryFeeValue ?? 0,
        discount: discountValue ?? 0,
        shippingAddress,
        notes,
        deliveryDeadline,
        confirmDuplicate,
        initialPayment: initialPaymentInput,
      });
      if (!parsed.success) {
        applyIssues(parsed.error.issues);
        return;
      }

      if (idempotencyKey.current === '') idempotencyKey.current = makeIdempotencyKey();
      const key = idempotencyKey.current;
      // Leave initialPayment out of the JSON body when blank so the 60 second create flow is unchanged.
      const createPayload =
        parsed.data.initialPayment == null
          ? { ...parsed.data, initialPayment: undefined }
          : parsed.data;
      run = () => createOrder(createPayload, key);
    } else {
      if (!order) return;
      const editItems = parsedLines.flatMap(({ line, quantity, price }) => {
        if (quantity === null || price === null) return [];
        return [
          {
            ...(line.lineId === undefined ? {} : { lineId: line.lineId }),
            productId: line.productId,
            variantId: line.variantId,
            quantity,
            ...(line.unitPrice.trim() === '' ? {} : { unitPrice: price }),
          },
        ];
      });
      const parsed = OrderUpdateSchema.safeParse({
        version: order.version,
        customerId: customer.id,
        items: editItems,
        deliveryFee: deliveryFeeValue ?? 0,
        discount: discountValue ?? 0,
        shippingAddress,
        notes,
        source,
        deliveryDeadline,
      } satisfies OrderUpdateRequest);
      if (!parsed.success) {
        applyIssues(parsed.error.issues);
        return;
      }
      run = () => updateOrder(order.id, parsed.data);
    }

    setIsSaving(true);
    try {
      const saved = await run();
      onSaved(saved);
    } catch (error) {
      if (error instanceof OrderApiError) {
        if (error.code === 'DUPLICATE_ORDER' && error.body.existingOrder) {
          setDuplicate(error.body.existingOrder);
          return;
        }
        if (error.status === 400) {
          setFieldErrors(error.fields);
          setFormError(error.message || 'Check the highlighted fields.');
          return;
        }
        if (error.code === 'ORDER_CHANGED' || error.code === 'ORDER_LOCKED') {
          setFormError(error.message);
          onConflict?.();
          return;
        }
        if (error.code === 'TOTAL_BELOW_PAID') {
          const paidDetail =
            error.body.paidAmount !== undefined
              ? ` (${formatMoney(error.body.paidAmount, currency)} paid)`
              : '';
          setFormError(
            `Order total cannot be lower than the amount already paid${paidDetail}. Refund or void payments before lowering the order total.`,
          );
          return;
        }
        setFormError(error.message);
        return;
      }

      if (isTimeoutError(error)) {
        setFormError(
          'The request timed out. The order may have been saved. Reload the orders list before trying again.',
        );
        return;
      }
      setFormError(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCustomerSelect = (next: OrderCustomerSelection | null) => {
    setCustomer(next);
    if (next !== null && mode === 'create') {
      setShippingAddress(next.address ?? '');
    }
  };

  return (
    <form
      className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      <div className="grid gap-8">
        {formError !== null && <Alert variant="danger">{formError}</Alert>}

        <section aria-labelledby="order-customer-heading" className="grid gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-sky-strong">Buyer</p>
            <h2 className="mt-1 text-xl font-semibold text-ink" id="order-customer-heading">
              Customer
            </h2>
          </div>
          <CustomerPicker disabled={isSaving} onSelect={handleCustomerSelect} selected={customer} />
          {fieldError('customerId') !== undefined && (
            <p className="text-sm text-danger" role="alert">
              {fieldError('customerId')}
            </p>
          )}
        </section>

        <section aria-labelledby="order-items-heading" className="grid gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-sky-strong">Lines</p>
            <h2 className="mt-1 text-xl font-semibold text-ink" id="order-items-heading">
              Items
            </h2>
            <p className="mt-1 text-sm text-body">
              Up to {MAX_ORDER_LINES} lines. Quantities are whole numbers from 1 to{' '}
              {MAX_LINE_QUANTITY}.
            </p>
          </div>

          {fieldError('items') !== undefined && (
            <p className="text-sm text-danger" role="alert">
              {fieldError('items')}
            </p>
          )}

          {lines.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-surface-muted p-4 text-sm text-body">
              No items yet. Search the catalog below to add the first one.
            </p>
          ) : (
            <ul className="grid gap-4">
              {lines.map((line) => {
                const quantityInvalid = parseQuantityInput(line.quantity) === null;
                const priceInvalid = effectiveLinePrice(line) === null;
                const subtotal = quantityInvalid || priceInvalid ? null : lineSubtotal(line);

                return (
                  <li key={line.key}>
                    <Card className="grid gap-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="font-semibold text-ink">{line.productName}</h3>
                          {line.variantLabel !== null && (
                            <p className="mt-1 text-sm text-body">{line.variantLabel}</p>
                          )}
                          {line.lineId !== undefined && (
                            <p className="mt-1 font-mono text-xs uppercase tracking-wide text-muted">
                              Saved line
                            </p>
                          )}
                        </div>
                        <Button
                          aria-label={`Remove ${line.productName}`}
                          disabled={isSaving}
                          onClick={() =>
                            setLines((current) => current.filter((entry) => entry.key !== line.key))
                          }
                          type="button"
                          variant="quiet"
                        >
                          <Trash2 aria-hidden="true" size={18} />
                        </Button>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        {line.variants.length > 0 && (
                          <Field htmlFor={`line-${line.key}-variant`} label="Variant">
                            <Select
                              disabled={isSaving}
                              id={`line-${line.key}-variant`}
                              onChange={(event) => {
                                const value = event.target.value;
                                const variant =
                                  line.variants.find((entry) => entry.id === value) ?? null;
                                updateLine(line.key, {
                                  variantId: variant?.id ?? null,
                                  variantLabel: variant?.label ?? null,
                                  defaultPrice: variant?.price ?? line.productPrice,
                                });
                              }}
                              value={line.variantId ?? ''}
                            >
                              <option value="">No variant</option>
                              {line.variants.map((variant) => (
                                <option key={variant.id} value={variant.id}>
                                  {variant.label}
                                  {variant.price !== null
                                    ? ` · ${formatMoney(variant.price, currency)}`
                                    : ''}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        )}

                        <Field
                          error={
                            quantityInvalid
                              ? `Enter a whole number from 1 to ${MAX_LINE_QUANTITY}.`
                              : undefined
                          }
                          htmlFor={`line-${line.key}-quantity`}
                          label="Quantity"
                        >
                          <Input
                            disabled={isSaving}
                            id={`line-${line.key}-quantity`}
                            inputMode="numeric"
                            max={MAX_LINE_QUANTITY}
                            min={1}
                            onChange={(event) =>
                              updateLine(line.key, { quantity: event.target.value })
                            }
                            type="number"
                            value={line.quantity}
                          />
                        </Field>

                        <Field
                          description={`Leave blank to use ${formatMoney(line.defaultPrice, currency)}.`}
                          error={
                            priceInvalid ? 'Enter a whole amount from 0 to 100,000,000.' : undefined
                          }
                          htmlFor={`line-${line.key}-price`}
                          label="Unit price override"
                        >
                          <Input
                            disabled={isSaving}
                            id={`line-${line.key}-price`}
                            inputMode="numeric"
                            min={0}
                            onChange={(event) =>
                              updateLine(line.key, { unitPrice: event.target.value })
                            }
                            placeholder={formatMoney(line.defaultPrice, currency)}
                            type="number"
                            value={line.unitPrice}
                          />
                        </Field>
                      </div>

                      <p className="border-t border-border pt-3 text-right font-mono text-sm text-ink">
                        Line total {subtotal === null ? '—' : formatMoney(subtotal, currency)}
                      </p>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}

          <ProductPicker currency={currency} disabled={isSaving} onAdd={handleAddProduct} />
        </section>

        <section aria-labelledby="order-details-heading" className="grid gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-sky-strong">
              Delivery and payment
            </p>
            <h2 className="mt-1 text-xl font-semibold text-ink" id="order-details-heading">
              Order details
            </h2>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field htmlFor="order-source" label="Source">
              <Select
                disabled={isSaving}
                id="order-source"
                onChange={(event) => setSource(event.target.value as OrderSourceType)}
                value={source}
              >
                {ORDER_SOURCES.map((option) => (
                  <option key={option} value={option}>
                    {ORDER_SOURCE_LABEL[option]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              description="Leave blank when there is no delivery fee."
              error={fieldError('deliveryFee')}
              htmlFor="order-delivery-fee"
              label="Delivery fee"
            >
              <Input
                disabled={isSaving}
                id="order-delivery-fee"
                inputMode="numeric"
                min={0}
                onChange={(event) => setDeliveryFee(event.target.value)}
                placeholder="0"
                type="number"
                value={deliveryFee}
              />
            </Field>

            <Field error={fieldError('discount')} htmlFor="order-discount" label="Discount">
              <Input
                aria-describedby={discountTooHigh ? 'order-discount-hint' : undefined}
                disabled={isSaving}
                id="order-discount"
                inputMode="numeric"
                min={0}
                onChange={(event) => setDiscount(event.target.value)}
                placeholder="0"
                type="number"
                value={discount}
              />
            </Field>

            <div className="hidden sm:block" />

            <div className="sm:col-span-2">
              <Field
                error={fieldError('shippingAddress')}
                htmlFor="order-shipping-address"
                label="Shipping address"
              >
                <Textarea
                  disabled={isSaving}
                  id="order-shipping-address"
                  maxLength={500}
                  onChange={(event) => setShippingAddress(event.target.value)}
                  placeholder="Where should this order go?"
                  value={shippingAddress}
                />
              </Field>
            </div>

            <div className="sm:col-span-2">
              <Field
                description="The day you promised the buyer. Leave it empty when there is no promise."
                error={fieldError('deliveryDeadline')}
                htmlFor="order-delivery-deadline"
                label="Delivery deadline"
              >
                <Input
                  disabled={isSaving}
                  id="order-delivery-deadline"
                  onChange={(event) => setDeliveryDeadline(event.target.value)}
                  type="date"
                  value={deliveryDeadline}
                />
              </Field>
              {deadlineInPast && (
                <p className="mt-2 text-caption text-warning" role="status">
                  This date has already passed. You can still save the order.
                </p>
              )}
            </div>

            <div className="sm:col-span-2">
              <Field error={fieldError('notes')} htmlFor="order-notes" label="Notes">
                <Textarea
                  disabled={isSaving}
                  id="order-notes"
                  maxLength={500}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Anything the packer or courier should know."
                  value={notes}
                />
              </Field>
            </div>
          </div>

          {discountTooHigh && (
            <p className="text-sm text-danger" id="order-discount-hint" role="alert">
              The discount cannot be more than the subtotal plus the delivery fee.
            </p>
          )}
        </section>
      </div>

      <aside aria-labelledby="order-summary-heading" className="lg:sticky lg:top-24">
        <Card className="grid gap-4">
          <h2 className="text-xl font-semibold text-ink" id="order-summary-heading">
            Order total
          </h2>

          <dl className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-body">Subtotal</dt>
              <dd className="font-mono text-ink">{formatMoney(totals.subtotal, currency)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-body">Delivery</dt>
              <dd className="font-mono text-ink">{formatMoney(totals.deliveryFee, currency)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-body">Discount</dt>
              <dd className="font-mono text-ink">−{formatMoney(totals.discount, currency)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-base">
              <dt className="font-semibold text-ink">Total</dt>
              <dd className="font-mono font-semibold text-ink">
                {formatMoney(totals.total, currency)}
              </dd>
            </div>
          </dl>

          {mode === 'create' && (
            <section
              aria-labelledby="order-initial-payment-heading"
              className="grid gap-3 border-t border-border pt-4"
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3
                    className="text-base font-semibold text-ink"
                    id="order-initial-payment-heading"
                  >
                    Payment received
                  </h3>
                  <p className="text-xs text-body">Leave amount blank if unpaid.</p>
                </div>
                <Button
                  disabled={isSaving || totals.total < 1}
                  onClick={() => {
                    setPaymentAmount(String(totals.total));
                    setFieldErrors((current) =>
                      current.filter((item) => item !== 'initialPayment.amount'),
                    );
                  }}
                  type="button"
                  variant="secondary"
                >
                  Full amount
                </Button>
              </div>

              <Field
                error={
                  paymentAmountAboveTotal
                    ? `Amount cannot exceed the live total of ${formatMoney(totals.total, currency)}.`
                    : fieldError('initialPayment.amount')
                }
                htmlFor="order-payment-amount"
                label="Amount received"
              >
                <Input
                  aria-invalid={
                    paymentAmountAboveTotal || fieldError('initialPayment.amount') !== undefined
                      ? true
                      : undefined
                  }
                  disabled={isSaving}
                  id="order-payment-amount"
                  inputMode="numeric"
                  min={1}
                  onChange={(event) => {
                    setPaymentAmount(event.target.value);
                    setFieldErrors((current) =>
                      current.filter((item) => item !== 'initialPayment.amount'),
                    );
                  }}
                  placeholder="0"
                  type="number"
                  value={paymentAmount}
                />
              </Field>

              <Field
                error={fieldError('initialPayment.method')}
                htmlFor="order-payment-method"
                label="Payment method"
              >
                <Select
                  disabled={isSaving}
                  id="order-payment-method"
                  onChange={(event) => setPaymentMethod(event.target.value as PaymentMethodType)}
                  value={effectivePaymentMethod}
                >
                  {allowedPaymentMethods.map((method) => (
                    <option key={method} value={method}>
                      {PAYMENT_METHOD_LABEL[method]}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                description={
                  isCardMethod(effectivePaymentMethod)
                    ? 'Never enter a full card number. Store only the receipt or transaction reference.'
                    : undefined
                }
                error={fieldError('initialPayment.referenceNumber')}
                htmlFor="order-payment-reference"
                label={paymentReferenceLabel(effectivePaymentMethod)}
              >
                <Input
                  disabled={isSaving}
                  id="order-payment-reference"
                  maxLength={100}
                  onChange={(event) => setPaymentReference(event.target.value)}
                  type="text"
                  value={paymentReference}
                />
              </Field>

              <Field
                error={fieldError('initialPayment.paymentDate')}
                htmlFor="order-payment-date"
                label="Payment date"
              >
                <Input
                  disabled={isSaving}
                  id="order-payment-date"
                  max={today ?? undefined}
                  onChange={(event) => setPaymentDateOverride(event.target.value)}
                  type="date"
                  value={effectivePaymentDate}
                />
              </Field>

              <Field
                error={fieldError('initialPayment.notes')}
                htmlFor="order-payment-notes"
                label="Payment notes (optional)"
              >
                <Textarea
                  disabled={isSaving}
                  id="order-payment-notes"
                  maxLength={500}
                  onChange={(event) => setPaymentNotes(event.target.value)}
                  placeholder="Optional payment note."
                  value={paymentNotes}
                />
              </Field>
            </section>
          )}

          <div className="grid gap-3">
            <Button disabled={isSaving} type="submit">
              {isSaving ? 'Saving…' : mode === 'create' ? 'Create order' : 'Save changes'}
            </Button>
            {onCancel ? (
              <Button disabled={isSaving} onClick={onCancel} type="button" variant="secondary">
                Cancel
              </Button>
            ) : (
              <NextLink
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:border-sky focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky"
                href="/orders"
              >
                Cancel
              </NextLink>
            )}
          </div>
        </Card>
      </aside>

      <Dialog
        description="A matching order was created in the last 24 hours."
        onClose={() => {
          if (!isSaving) setDuplicate(null);
        }}
        open={duplicate !== null}
        title="This looks like a duplicate"
      >
        {duplicate !== null && (
          <div className="grid gap-4">
            <div className="rounded-md border border-border bg-surface-muted p-4">
              <p className="font-mono text-sm font-semibold text-sky-strong">
                {duplicate.orderNumber}
              </p>
              <p className="mt-1 text-sm text-body">
                {formatMoney(duplicate.total, currency)} ·{' '}
                {formatDateTime(duplicate.createdAt, timezone)}
              </p>
            </div>
            <p className="text-sm text-body">
              Check the existing order before creating another one for the same items.
            </p>
            <div className="flex flex-wrap gap-3">
              <NextLink
                className="inline-flex min-h-11 items-center rounded-md bg-sky px-4 text-sm font-semibold text-on-sky transition-colors hover:bg-sky-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky"
                href={`/orders/${duplicate.id}`}
              >
                View existing order
              </NextLink>
              <Button
                disabled={isSaving}
                onClick={() => void submit(true)}
                type="button"
                variant="secondary"
              >
                Create anyway
              </Button>
              <Button
                disabled={isSaving}
                onClick={() => setDuplicate(null)}
                type="button"
                variant="quiet"
              >
                Go back
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </form>
  );
}
