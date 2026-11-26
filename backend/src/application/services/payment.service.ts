import {
  IsoDateSchema,
  OrderDto,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PaymentAuditAction,
  PaymentCreateRequest,
  PaymentLedgerPageDto,
  PaymentMethodType,
  PaymentVoidRequest,
} from '@f-commerce/contracts';
import { PaymentKind, PaymentMethod } from '../../domain/entities/financial.entity.js';
import { isMethodAllowedForCurrency } from '../../domain/order-payments.js';
import {
  decodePaymentLedgerCursor,
  encodePaymentLedgerCursor,
  PAYMENT_DEFAULT_PAGE_SIZE,
  PAYMENT_MAX_PAGE_SIZE,
  paymentMethodKey,
} from '../../domain/payment-cursor.js';
import { todayInTimeZone } from '../../domain/timezone.js';
import { IPaymentRepository } from '../../domain/repositories/payment.repository.js';
import {
  IdempotencyKeyConflictError,
  NotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import { isUniqueViolation } from './database-errors.js';
import { toOrderDto, toPaymentLedgerItemDto } from './order-dto.js';

const MAX_LEDGER_RANGE_DIFF_DAYS = 365; // 366 inclusive calendar days (e.g. leap year Jan 1 to Dec 31).

function calendarDayDiff(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = to.split('-').map(Number);
  const fromUtc = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const toUtc = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

export interface PaymentActor {
  businessId: string;
  userId: string;
}

/**
 * Validate a payment method and calendar date against the active business's
 * currency and timezone. `fieldPrefix` is `''` on standalone payment endpoints
 * and `'initialPayment.'` on order creation.
 */
export function validatePaymentAgainstBusiness(
  input: { method: PaymentMethodType; paymentDate: string | null },
  settings: { currency: string; timezone: string },
  fieldPrefix: string = '',
): { paymentDate: string } {
  if (!isMethodAllowedForCurrency(input.method, settings.currency)) {
    throw new ValidationError(
      [`${fieldPrefix}method`],
      'This payment method is only available for BDT businesses',
    );
  }

  const businessToday = todayInTimeZone(settings.timezone);
  const paymentDate = input.paymentDate ?? businessToday;
  if (paymentDate > businessToday) {
    throw new ValidationError(
      [`${fieldPrefix}paymentDate`],
      'Payment date cannot be in the future',
    );
  }

  return { paymentDate };
}

export class PaymentService {
  constructor(private readonly repository: IPaymentRepository) {}

  /**
   * Check order existence (404) first, then resolve an optional Idempotency-Key
   * before body validation so replays never leak across orders or endpoints.
   */
  async ensureOrderAndCheckIdempotency(
    orderId: string,
    expectedKind: PaymentKind,
    idempotencyKey: string | null,
  ): Promise<OrderDto | null> {
    const exists = await this.repository.orderExists(orderId);
    if (!exists) {
      throw new NotFoundError('Order not found');
    }

    if (idempotencyKey === null) return null;

    const existing = await this.repository.findByIdempotencyKey(idempotencyKey);
    if (!existing) return null;

    if (existing.orderId !== orderId || existing.kind !== expectedKind) {
      throw new IdempotencyKeyConflictError();
    }

    const detail = await this.repository.findOrderDetail(orderId);
    if (!detail) {
      throw new NotFoundError('Order not found');
    }
    return toOrderDto(detail);
  }

  async recordPayment(
    orderId: string,
    input: PaymentCreateRequest,
    actor: PaymentActor,
    idempotencyKey: string | null,
  ): Promise<{ order: OrderDto; replayed: boolean }> {
    return this.recordEntry(
      orderId,
      PaymentKind.PAYMENT,
      PaymentAuditAction.RECORDED,
      input,
      actor,
      idempotencyKey,
    );
  }

  async recordRefund(
    orderId: string,
    input: PaymentCreateRequest,
    actor: PaymentActor,
    idempotencyKey: string | null,
  ): Promise<{ order: OrderDto; replayed: boolean }> {
    return this.recordEntry(
      orderId,
      PaymentKind.REFUND,
      PaymentAuditAction.REFUND_RECORDED,
      input,
      actor,
      idempotencyKey,
    );
  }

  async voidPayment(
    orderId: string,
    paymentId: string,
    input: PaymentVoidRequest,
    actor: PaymentActor,
  ): Promise<OrderDto> {
    const actorName = (await this.repository.findActorName(actor.userId)) ?? 'Unknown user';
    const detail = await this.repository.voidEntry(
      orderId,
      paymentId,
      {
        voidedByUserId: actor.userId,
        voidedByName: actorName,
        reason: input.reason,
      },
      {
        businessId: actor.businessId,
        userId: actor.userId,
        action: PaymentAuditAction.VOIDED,
      },
    );
    return toOrderDto(detail);
  }

  async listLedger(raw: {
    from?: string;
    to?: string;
    method?: string;
    kind?: string;
    limit?: string;
    cursor?: string;
  }): Promise<PaymentLedgerPageDto> {
    const settings = await this.repository.findBusinessSettings();
    if (!settings) {
      throw new NotFoundError('Business not found');
    }

    const businessToday = todayInTimeZone(settings.timezone);
    const defaultFrom = `${businessToday.slice(0, 7)}-01`;

    const from = this.parseLedgerDate(raw.from, defaultFrom, 'from');
    const to = this.parseLedgerDate(raw.to, businessToday, 'to');
    if (from > to) {
      throw new ValidationError(['from', 'to'], 'Start date must be on or before end date');
    }
    if (calendarDayDiff(from, to) > MAX_LEDGER_RANGE_DIFF_DAYS) {
      throw new ValidationError(['from', 'to'], 'Date range cannot exceed 366 inclusive days');
    }

    const methods = this.parseMethods(raw.method);
    const kind = this.parseKind(raw.kind);
    const limit = this.parseLimit(raw.limit);
    const methodKey = paymentMethodKey(methods);

    let anchor: { paymentDate: string; createdAt: Date; id: string } | undefined;
    if (raw.cursor !== undefined && raw.cursor !== '') {
      const decoded = decodePaymentLedgerCursor(raw.cursor, {
        from,
        to,
        methods: methodKey,
        kind: kind ?? '',
        limit,
      });
      if (!decoded) {
        throw new ValidationError(['cursor']);
      }
      anchor = {
        paymentDate: decoded.paymentDate,
        createdAt: decoded.createdAt,
        id: decoded.id,
      };
    }

    const result = await this.repository.listLedger({
      from,
      to,
      methods,
      kind,
      limit,
      cursorPaymentDate: anchor?.paymentDate,
      cursorCreatedAt: anchor?.createdAt,
      cursorId: anchor?.id,
    });

    const last = result.items[result.items.length - 1];
    const nextCursor =
      result.hasMore && last
        ? encodePaymentLedgerCursor({
            paymentDate: last.paymentDate,
            createdAt: last.createdAt,
            id: last.id,
            from,
            to,
            methods: methodKey,
            kind: kind ?? '',
            limit,
          })
        : null;

    return {
      items: result.items.map(toPaymentLedgerItemDto),
      summary: result.summary,
      nextCursor,
    };
  }

  private parseLedgerDate(raw: string | undefined, fallback: string, field: string): string {
    if (raw === undefined || raw.trim() === '') return fallback;
    const trimmed = raw.trim();
    const parsed = IsoDateSchema.safeParse(trimmed);
    if (!parsed.success) {
      throw new ValidationError([field]);
    }
    return parsed.data;
  }

  private parseMethods(raw: string | undefined): PaymentMethod[] {
    if (raw === undefined || raw.trim() === '') return [];
    const result: PaymentMethod[] = [];
    for (const part of raw.split(',')) {
      const value = part.trim();
      if (value === '') continue;
      if (!(PAYMENT_METHODS as readonly string[]).includes(value)) {
        throw new ValidationError(['method']);
      }
      const method = value as PaymentMethod;
      if (!result.includes(method)) result.push(method);
    }
    return result;
  }

  private parseKind(raw: string | undefined): PaymentKind | undefined {
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = raw.trim();
    if (!(PAYMENT_KINDS as readonly string[]).includes(value)) {
      throw new ValidationError(['kind']);
    }
    return value as PaymentKind;
  }

  private parseLimit(raw: string | undefined): number {
    if (raw === undefined || raw === '') return PAYMENT_DEFAULT_PAGE_SIZE;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > PAYMENT_MAX_PAGE_SIZE) {
      throw new ValidationError(['limit']);
    }
    return value;
  }

  private async recordEntry(
    orderId: string,
    kind: PaymentKind,
    auditAction: string,
    input: PaymentCreateRequest,
    actor: PaymentActor,
    idempotencyKey: string | null,
  ): Promise<{ order: OrderDto; replayed: boolean }> {
    const settings = await this.repository.findBusinessSettings();
    if (!settings) {
      throw new NotFoundError('Business not found');
    }

    const { paymentDate } = validatePaymentAgainstBusiness(input, settings);
    const actorName = (await this.repository.findActorName(actor.userId)) ?? 'Unknown user';

    try {
      const detail = await this.repository.recordEntry(
        orderId,
        {
          kind,
          amount: input.amount,
          method: input.method as PaymentMethod,
          paymentDate,
          referenceNumber: input.referenceNumber,
          notes: input.notes,
          recordedByUserId: actor.userId,
          recordedByName: actorName,
          idempotencyKey,
        },
        {
          businessId: actor.businessId,
          userId: actor.userId,
          action: auditAction,
        },
      );
      return { order: toOrderDto(detail), replayed: false };
    } catch (error) {
      if (idempotencyKey !== null && isUniqueViolation(error)) {
        const existing = await this.repository.findByIdempotencyKey(idempotencyKey);
        if (existing) {
          if (existing.orderId !== orderId || existing.kind !== kind) {
            throw new IdempotencyKeyConflictError();
          }
          const detail = await this.repository.findOrderDetail(orderId);
          if (detail) {
            return { order: toOrderDto(detail), replayed: true };
          }
        }
      }
      throw error;
    }
  }
}
