/**
 * Opaque paging cursors for the order list. The cursor carries the last row's
 * sort key plus the status set, payment status set, search text, and page size
 * it was built for, so it cannot be replayed against a different query.
 */

import type { PaymentStatusFilterType } from '@f-commerce/contracts';
import { OrderStatus } from './entities/order.entity.js';
import { isUuid } from './uuid.js';

export const ORDER_DEFAULT_PAGE_SIZE = 20;
export const ORDER_MAX_PAGE_SIZE = 50;

/** Canonical order of a status set, used to bind a cursor to its filter. */
export function orderStatusKey(statuses: OrderStatus[]): string {
  return [...new Set(statuses)].sort().join(',');
}

/** Canonical order of a payment status filter set, used to bind a cursor. */
export function orderPaymentStatusKey(paymentStatuses: PaymentStatusFilterType[]): string {
  return [...new Set(paymentStatuses)].sort().join(',');
}

function encode(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(raw: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface OrderListCursorPayload {
  createdAt: Date;
  id: string;
  statuses: string;
  paymentStatuses: string;
  q: string;
  limit: number;
}

export function encodeOrderListCursor(payload: OrderListCursorPayload): string {
  return encode({
    createdAt: payload.createdAt.toISOString(),
    _id: payload.id,
    statuses: payload.statuses,
    paymentStatuses: payload.paymentStatuses,
    q: payload.q,
    limit: payload.limit,
  });
}

/**
 * Decode a list cursor. Returns null when the cursor is malformed or was built
 * for a different status set, payment status set, search text, or page size.
 */
export function decodeOrderListCursor(
  raw: string,
  statuses: string,
  paymentStatuses: string,
  q: string,
  limit: number,
): OrderListCursorPayload | null {
  const parsed = decode(raw);
  if (!parsed) return null;
  const {
    createdAt,
    _id,
    statuses: cursorStatuses,
    paymentStatuses: cursorPaymentStatuses,
    q: cursorQ,
    limit: cursorLimit,
  } = parsed;
  if (typeof createdAt !== 'string' || typeof _id !== 'string' || !isUuid(_id)) return null;
  if (typeof cursorStatuses !== 'string' || typeof cursorQ !== 'string') return null;
  const normalizedPaymentStatuses =
    typeof cursorPaymentStatuses === 'string' ? cursorPaymentStatuses : '';
  if (typeof cursorLimit !== 'number' || cursorLimit !== limit) return null;
  if (
    cursorStatuses !== statuses ||
    normalizedPaymentStatuses !== paymentStatuses ||
    cursorQ !== q
  ) {
    return null;
  }
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return {
    createdAt: date,
    id: _id,
    statuses: cursorStatuses,
    paymentStatuses: normalizedPaymentStatuses,
    q: cursorQ,
    limit: cursorLimit,
  };
}
