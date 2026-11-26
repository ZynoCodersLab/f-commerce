/**
 * Opaque paging cursors for `GET /api/payments`. Serializes plain normalized
 * filter fields alongside the last row's sort keys `(paymentDate, createdAt, id)`.
 */

import { PaymentKind, PaymentMethod } from './entities/financial.entity.js';
import { isUuid } from './uuid.js';

export const PAYMENT_DEFAULT_PAGE_SIZE = 20;
export const PAYMENT_MAX_PAGE_SIZE = 50;

export function paymentMethodKey(methods: PaymentMethod[]): string {
  return [...new Set(methods)].sort().join(',');
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

export interface PaymentLedgerCursorPayload {
  paymentDate: string;
  createdAt: Date;
  id: string;
  from: string;
  to: string;
  methods: string;
  kind: PaymentKind | '';
  limit: number;
}

export function encodePaymentLedgerCursor(payload: PaymentLedgerCursorPayload): string {
  return encode({
    paymentDate: payload.paymentDate,
    createdAt: payload.createdAt.toISOString(),
    _id: payload.id,
    from: payload.from,
    to: payload.to,
    methods: payload.methods,
    kind: payload.kind,
    limit: payload.limit,
  });
}

/**
 * Decode a ledger cursor. Returns null when malformed or built for different
 * date bounds, methods, kind, or limit.
 */
export function decodePaymentLedgerCursor(
  raw: string,
  expected: { from: string; to: string; methods: string; kind: PaymentKind | ''; limit: number },
): PaymentLedgerCursorPayload | null {
  const parsed = decode(raw);
  if (!parsed) return null;

  const { paymentDate, createdAt, _id, from, to, methods, kind, limit } = parsed;
  if (typeof paymentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return null;
  if (typeof createdAt !== 'string' || typeof _id !== 'string' || !isUuid(_id)) return null;
  if (typeof from !== 'string' || typeof to !== 'string' || typeof methods !== 'string') {
    return null;
  }
  if (typeof kind !== 'string' || typeof limit !== 'number') return null;
  if (
    from !== expected.from ||
    to !== expected.to ||
    methods !== expected.methods ||
    kind !== expected.kind ||
    limit !== expected.limit
  ) {
    return null;
  }

  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;

  return {
    paymentDate,
    createdAt: date,
    id: _id,
    from,
    to,
    methods,
    kind: kind as PaymentKind | '',
    limit,
  };
}
