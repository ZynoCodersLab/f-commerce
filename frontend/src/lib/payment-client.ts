import type {
  OrderDto,
  PaymentCreateRequest,
  PaymentKindType,
  PaymentLedgerPageDto,
  PaymentMethodType,
  PaymentVoidRequest,
} from '@f-commerce/contracts';
import { apiFetch } from './auth-client';
import { OrderApiError, type OrderErrorBody } from './order-client';

export interface PaymentLedgerFilterQuery {
  from?: string;
  to?: string;
  methods?: PaymentMethodType[];
  kind?: PaymentKindType | '';
  limit?: number;
  cursor?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function parsePaymentResponse<T>(response: Response): Promise<T> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const record = isRecord(payload) ? payload : {};
    const body: OrderErrorBody = {
      error: typeof record.error === 'string' ? record.error : undefined,
      message: typeof record.message === 'string' ? record.message : undefined,
      fields: Array.isArray(record.fields)
        ? record.fields.filter((field): field is string => typeof field === 'string')
        : undefined,
      dueAmount: typeof record.dueAmount === 'number' ? record.dueAmount : undefined,
      paidAmount: typeof record.paidAmount === 'number' ? record.paidAmount : undefined,
      total: typeof record.total === 'number' ? record.total : undefined,
    };

    throw new OrderApiError(
      body.message ?? body.error ?? 'The request failed',
      response.status,
      body.error,
      body.fields ?? [],
      body,
    );
  }

  if (response.status === 204) return undefined as T;
  if (isRecord(payload) && 'data' in payload) return payload.data as T;
  return payload as T;
}

export async function recordOrderPayment(
  orderId: string,
  input: PaymentCreateRequest,
  idempotencyKey: string,
): Promise<OrderDto> {
  const response = await apiFetch(`/api/orders/${encodeURIComponent(orderId)}/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(input),
  });
  return parsePaymentResponse<OrderDto>(response);
}

export async function recordOrderRefund(
  orderId: string,
  input: PaymentCreateRequest,
  idempotencyKey: string,
): Promise<OrderDto> {
  const response = await apiFetch(`/api/orders/${encodeURIComponent(orderId)}/refunds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(input),
  });
  return parsePaymentResponse<OrderDto>(response);
}

export async function voidOrderPayment(
  orderId: string,
  paymentId: string,
  input: PaymentVoidRequest,
): Promise<OrderDto> {
  const response = await apiFetch(
    `/api/orders/${encodeURIComponent(orderId)}/payments/${encodeURIComponent(paymentId)}/void`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  return parsePaymentResponse<OrderDto>(response);
}

export function buildPaymentLedgerQuery(query: PaymentLedgerFilterQuery): string {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.methods && query.methods.length > 0) {
    params.set('method', query.methods.join(','));
  }
  if (query.kind) params.set('kind', query.kind);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);

  const serialized = params.toString();
  return serialized === '' ? '' : `?${serialized}`;
}

export async function listPayments(query: PaymentLedgerFilterQuery): Promise<PaymentLedgerPageDto> {
  const response = await apiFetch(`/api/payments${buildPaymentLedgerQuery(query)}`);
  return parsePaymentResponse<PaymentLedgerPageDto>(response);
}
