import type {
  DuplicateOrderExisting,
  OrderCreateRequest,
  OrderDto,
  OrderPageDto,
  OrderStatusChangeRequest,
  OrderStatusType,
  OrderUpdateRequest,
  PaymentStatusFilterType,
} from '@f-commerce/contracts';
import { apiFetch } from './auth-client';

export interface OrderQuery {
  statuses?: OrderStatusType[];
  paymentStatuses?: PaymentStatusFilterType[];
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export interface OrderErrorBody {
  error?: string;
  message?: string;
  fields?: string[];
  existingOrder?: DuplicateOrderExisting;
  dueAmount?: number;
  paidAmount?: number;
  total?: number;
}

/** A failed order request with the server's machine-readable details. */
export class OrderApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly fields: string[],
    public readonly body: OrderErrorBody,
  ) {
    super(message);
    this.name = 'OrderApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toExistingOrder(value: unknown): DuplicateOrderExisting | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== 'string' ||
    typeof value.orderNumber !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.total !== 'number' ||
    typeof value.createdAt !== 'string'
  ) {
    return undefined;
  }

  return {
    id: value.id,
    orderNumber: value.orderNumber,
    status: value.status as DuplicateOrderExisting['status'],
    total: value.total,
    createdAt: value.createdAt,
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
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
      existingOrder: toExistingOrder(record.existingOrder),
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

export function buildOrderQuery(query: OrderQuery): string {
  const params = new URLSearchParams();
  if (query.statuses && query.statuses.length > 0) {
    params.set('status', query.statuses.join(','));
  }
  if (query.paymentStatuses && query.paymentStatuses.length > 0) {
    params.set('paymentStatus', query.paymentStatuses.join(','));
  }
  const search = query.q?.trim();
  if (search) params.set('q', search);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);

  const serialized = params.toString();
  return serialized === '' ? '' : `?${serialized}`;
}

export async function listOrders(query: OrderQuery): Promise<OrderPageDto> {
  const response = await apiFetch(`/api/orders${buildOrderQuery(query)}`);
  return parseResponse<OrderPageDto>(response);
}

export async function getOrder(id: string): Promise<OrderDto> {
  const response = await apiFetch(`/api/orders/${encodeURIComponent(id)}`);
  return parseResponse<OrderDto>(response);
}

export async function createOrder(
  input: Omit<OrderCreateRequest, 'initialPayment'> & {
    initialPayment?: OrderCreateRequest['initialPayment'];
  },
  idempotencyKey: string,
): Promise<OrderDto> {
  const response = await apiFetch('/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(input),
  });
  return parseResponse<OrderDto>(response);
}

export async function updateOrder(id: string, input: OrderUpdateRequest): Promise<OrderDto> {
  const response = await apiFetch(`/api/orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseResponse<OrderDto>(response);
}

export async function changeOrderStatus(
  id: string,
  input: OrderStatusChangeRequest,
): Promise<OrderDto> {
  const response = await apiFetch(`/api/orders/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseResponse<OrderDto>(response);
}
