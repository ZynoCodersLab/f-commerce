import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentAuditAction, type PaymentCreateRequest } from '@f-commerce/contracts';
import {
  PaymentKind,
  PaymentMethod,
  type Payment,
} from '../../domain/entities/financial.entity.js';
import { OrderStatus, type OrderDetail } from '../../domain/entities/order.entity.js';
import {
  IdempotencyKeyConflictError,
  NotFoundError,
  ValidationError,
} from '../../domain/errors.js';
import {
  decodePaymentLedgerCursor,
  encodePaymentLedgerCursor,
} from '../../domain/payment-cursor.js';
import type { IPaymentRepository } from '../../domain/repositories/payment.repository.js';
import { PaymentService, validatePaymentAgainstBusiness } from './payment.service.js';

const BIZ_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ORDER_ID = '33333333-3333-4333-8333-333333333333';
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const CREATED_AT = new Date('2026-11-26T10:00:00.000Z');

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: PAYMENT_ID,
    businessId: BIZ_ID,
    orderId: ORDER_ID,
    kind: PaymentKind.PAYMENT,
    amount: 500,
    method: PaymentMethod.CASH,
    referenceNumber: undefined,
    notes: undefined,
    paymentDate: '2026-11-26',
    recordedByUserId: USER_ID,
    recordedByName: 'Maya Owner',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeOrderDetail(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return {
    order: {
      id: ORDER_ID,
      businessId: BIZ_ID,
      customerId: '66666666-6666-4666-8666-666666666666',
      orderNumber: 'ORD-0001',
      status: OrderStatus.PENDING,
      customerNameSnapshot: 'Nusrat Jahan',
      customerPhoneSnapshot: '+8801712345678',
      subtotal: 1200,
      deliveryFee: 0,
      discount: 0,
      total: 1200,
      paidAmount: 500,
      dueAmount: 700,
      source: 'DIRECT',
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    items: [],
    history: [],
    payments: [makePayment()],
    ...overrides,
  };
}

function createMockRepository(overrides: Partial<IPaymentRepository> = {}): IPaymentRepository {
  return {
    orderExists: vi.fn().mockResolvedValue(true),
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    findBusinessSettings: vi.fn().mockResolvedValue({ currency: 'BDT', timezone: 'Asia/Dhaka' }),
    findActorName: vi.fn().mockResolvedValue('Maya Owner'),
    findOrderDetail: vi.fn().mockResolvedValue(makeOrderDetail()),
    recordEntry: vi.fn().mockResolvedValue(makeOrderDetail()),
    voidEntry: vi.fn().mockResolvedValue(makeOrderDetail()),
    listLedger: vi.fn().mockResolvedValue({
      items: [],
      summary: { collected: 0, refunded: 0, net: 0 },
      hasMore: false,
    }),
    ...overrides,
  };
}

function createInput(overrides: Partial<PaymentCreateRequest> = {}): PaymentCreateRequest {
  return {
    amount: 500,
    method: 'CASH',
    paymentDate: null,
    referenceNumber: null,
    notes: null,
    ...overrides,
  };
}

const ACTOR = { businessId: BIZ_ID, userId: USER_ID };

describe('validatePaymentAgainstBusiness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-11-26 12:00 UTC -> 2026-11-27 in Pacific/Kiritimati (+14), 2026-11-26 in America/New_York (-5)
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // covers spec 0010 AC-13: BKASH and NAGAD require BDT and use caller field prefix
  it('enforces BDT currency for BKASH and NAGAD with and without field prefix', () => {
    expect(
      validatePaymentAgainstBusiness(
        { method: 'BKASH', paymentDate: null },
        { currency: 'BDT', timezone: 'Asia/Dhaka' },
      ),
    ).toEqual({ paymentDate: '2026-11-26' });

    for (const currency of ['USD', 'EUR']) {
      for (const method of ['BKASH', 'NAGAD'] as const) {
        expect(() =>
          validatePaymentAgainstBusiness(
            { method, paymentDate: null },
            { currency, timezone: 'Asia/Dhaka' },
          ),
        ).toThrow(ValidationError);

        try {
          validatePaymentAgainstBusiness(
            { method, paymentDate: null },
            { currency, timezone: 'Asia/Dhaka' },
            'initialPayment.',
          );
          expect.unreachable('should throw');
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationError);
          expect((error as ValidationError).fields).toEqual(['initialPayment.method']);
        }
      }
    }
  });

  // covers spec 0010 AC-14: defaults date to business timezone today and rejects future days in that zone
  it('defaults null paymentDate to timezone today, accepts past dates, and rejects future dates', () => {
    expect(
      validatePaymentAgainstBusiness(
        { method: 'CASH', paymentDate: null },
        { currency: 'USD', timezone: 'Pacific/Kiritimati' },
      ),
    ).toEqual({ paymentDate: '2026-11-27' });

    expect(
      validatePaymentAgainstBusiness(
        { method: 'CASH', paymentDate: '2026-11-20' },
        { currency: 'USD', timezone: 'America/New_York' },
      ),
    ).toEqual({ paymentDate: '2026-11-20' });

    try {
      validatePaymentAgainstBusiness(
        { method: 'CASH', paymentDate: '2026-11-27' },
        { currency: 'USD', timezone: 'America/New_York' },
        'initialPayment.',
      );
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fields).toEqual(['initialPayment.paymentDate']);
    }
  });
});

describe('PaymentService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // covers spec 0010 AC-12: checks order existence before idempotency key lookup and detects cross-order/kind conflicts
  it('enforces order existence before idempotency lookup and detects conflicts', async () => {
    const repoMissingOrder = createMockRepository({
      orderExists: vi.fn().mockResolvedValue(false),
    });
    const serviceMissing = new PaymentService(repoMissingOrder);

    await expect(
      serviceMissing.ensureOrderAndCheckIdempotency(ORDER_ID, PaymentKind.PAYMENT, 'key-1'),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repoMissingOrder.findByIdempotencyKey).not.toHaveBeenCalled();

    const repoUnused = createMockRepository();
    const serviceUnused = new PaymentService(repoUnused);
    await expect(
      serviceUnused.ensureOrderAndCheckIdempotency(ORDER_ID, PaymentKind.PAYMENT, null),
    ).resolves.toBeNull();
    await expect(
      serviceUnused.ensureOrderAndCheckIdempotency(ORDER_ID, PaymentKind.PAYMENT, 'unused-key'),
    ).resolves.toBeNull();

    const repoMatch = createMockRepository({
      findByIdempotencyKey: vi
        .fn()
        .mockResolvedValue(makePayment({ orderId: ORDER_ID, kind: PaymentKind.PAYMENT })),
    });
    const serviceMatch = new PaymentService(repoMatch);
    const replayed = await serviceMatch.ensureOrderAndCheckIdempotency(
      ORDER_ID,
      PaymentKind.PAYMENT,
      'key-1',
    );
    expect(replayed?.orderNumber).toBe('ORD-0001');

    await expect(
      serviceMatch.ensureOrderAndCheckIdempotency(OTHER_ORDER_ID, PaymentKind.PAYMENT, 'key-1'),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    await expect(
      serviceMatch.ensureOrderAndCheckIdempotency(ORDER_ID, PaymentKind.REFUND, 'key-1'),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    const repoMissingDetail = createMockRepository({
      findByIdempotencyKey: vi.fn().mockResolvedValue(makePayment()),
      findOrderDetail: vi.fn().mockResolvedValue(null),
    });
    await expect(
      new PaymentService(repoMissingDetail).ensureOrderAndCheckIdempotency(
        ORDER_ID,
        PaymentKind.PAYMENT,
        'key-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // covers spec 0010 AC-3, AC-5, AC-12, AC-15: writes entries with audit actions, Unknown user fallback, and race recovery
  it('records payments and refunds, handles missing business/actor fallback, and resolves unique key races', async () => {
    const noBizService = new PaymentService(
      createMockRepository({ findBusinessSettings: vi.fn().mockResolvedValue(null) }),
    );
    await expect(
      noBizService.recordPayment(ORDER_ID, createInput(), ACTOR, null),
    ).rejects.toBeInstanceOf(NotFoundError);

    const repo = createMockRepository({ findActorName: vi.fn().mockResolvedValue(null) });
    const service = new PaymentService(repo);
    await service.recordPayment(ORDER_ID, createInput({ method: 'BKASH' }), ACTOR, 'k-pay');
    expect(vi.mocked(repo.recordEntry).mock.calls[0]?.[1]).toMatchObject({
      kind: PaymentKind.PAYMENT,
      recordedByName: 'Unknown user',
      idempotencyKey: 'k-pay',
    });
    expect(vi.mocked(repo.recordEntry).mock.calls[0]?.[2]).toMatchObject({
      action: PaymentAuditAction.RECORDED,
    });

    await service.recordRefund(ORDER_ID, createInput({ amount: 200 }), ACTOR, 'k-ref');
    expect(vi.mocked(repo.recordEntry).mock.calls[1]?.[1]).toMatchObject({
      kind: PaymentKind.REFUND,
      idempotencyKey: 'k-ref',
    });
    expect(vi.mocked(repo.recordEntry).mock.calls[1]?.[2]).toMatchObject({
      action: PaymentAuditAction.REFUND_RECORDED,
    });

    // Unique constraint violation on same order + kind -> replays stored order detail.
    const dupErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    const raceMatchRepo = createMockRepository({
      recordEntry: vi.fn().mockRejectedValue(dupErr),
      findByIdempotencyKey: vi
        .fn()
        .mockResolvedValue(makePayment({ orderId: ORDER_ID, kind: PaymentKind.PAYMENT })),
    });
    const raceResult = await new PaymentService(raceMatchRepo).recordPayment(
      ORDER_ID,
      createInput(),
      ACTOR,
      'race-key',
    );
    expect(raceResult.replayed).toBe(true);
    expect(raceResult.order.id).toBe(ORDER_ID);

    // Unique violation stored against different order or kind -> 409 conflict.
    const raceMismatchRepo = createMockRepository({
      recordEntry: vi.fn().mockRejectedValue(dupErr),
      findByIdempotencyKey: vi
        .fn()
        .mockResolvedValue(makePayment({ orderId: OTHER_ORDER_ID, kind: PaymentKind.PAYMENT })),
    });
    await expect(
      new PaymentService(raceMismatchRepo).recordPayment(
        ORDER_ID,
        createInput(),
        ACTOR,
        'race-key',
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

    // Non-unique errors or null idempotencyKey rethrow untouched.
    await expect(
      new PaymentService(
        createMockRepository({ recordEntry: vi.fn().mockRejectedValue(dupErr) }),
      ).recordPayment(ORDER_ID, createInput(), ACTOR, null),
    ).rejects.toBe(dupErr);
  });

  // covers spec 0010 AC-6 and AC-15: voidPayment passes actor snapshot fallback and PAYMENT_VOIDED action
  it('voids an entry with actor name fallback and audit metadata', async () => {
    const repo = createMockRepository({ findActorName: vi.fn().mockResolvedValue(null) });
    const service = new PaymentService(repo);

    const dto = await service.voidPayment(
      ORDER_ID,
      PAYMENT_ID,
      { reason: 'Duplicate entry' },
      ACTOR,
    );

    expect(dto.id).toBe(ORDER_ID);
    expect(repo.voidEntry).toHaveBeenCalledWith(
      ORDER_ID,
      PAYMENT_ID,
      { voidedByUserId: USER_ID, voidedByName: 'Unknown user', reason: 'Duplicate entry' },
      { businessId: BIZ_ID, userId: USER_ID, action: PaymentAuditAction.VOIDED },
    );
  });

  // covers spec 0010 AC-17: listLedger defaults, 366-day cap, filter validation, and cursor decoding
  it('validates listLedger dates, 366-day leap cap, methods, kind, limit, and cursor state', async () => {
    const noBiz = new PaymentService(
      createMockRepository({ findBusinessSettings: vi.fn().mockResolvedValue(null) }),
    );
    await expect(noBiz.listLedger({})).rejects.toBeInstanceOf(NotFoundError);

    const repo = createMockRepository({
      listLedger: vi.fn().mockResolvedValue({
        items: [
          {
            ...makePayment(),
            orderNumber: 'ORD-0001',
            customerNameSnapshot: 'Nusrat Jahan',
          },
        ],
        summary: { collected: 500, refunded: 0, net: 500 },
        hasMore: true,
      }),
    });
    const service = new PaymentService(repo);

    // Defaults to current month start -> today in business timezone, allows future filter dates & deduplicates methods.
    const defaultPage = await service.listLedger({
      method: 'NAGAD, BKASH, NAGAD',
      kind: 'PAYMENT',
      limit: '10',
    });
    expect(vi.mocked(repo.listLedger).mock.calls[0]?.[0]).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-26',
      methods: [PaymentMethod.NAGAD, PaymentMethod.BKASH],
      kind: PaymentKind.PAYMENT,
      limit: 10,
    });
    expect(defaultPage.nextCursor).toBeTruthy();
    const decoded = decodePaymentLedgerCursor(defaultPage.nextCursor!, {
      from: '2026-11-01',
      to: '2026-11-26',
      methods: 'BKASH,NAGAD',
      kind: PaymentKind.PAYMENT,
      limit: 10,
    });
    expect(decoded?.id).toBe(PAYMENT_ID);

    // 366 inclusive days in leap year 2024 accepted; 367 days rejected.
    await expect(
      service.listLedger({ from: '2024-01-01', to: '2024-12-31' }),
    ).resolves.toBeDefined();
    await expect(
      service.listLedger({ from: '2026-11-01', to: '2026-12-15' }),
    ).resolves.toBeDefined();

    const validationCases: [string, Record<string, string>, string[]][] = [
      ['from after to', { from: '2026-11-10', to: '2026-11-01' }, ['from', 'to']],
      ['367 inclusive days', { from: '2024-01-01', to: '2025-01-01' }, ['from', 'to']],
      ['invalid from date', { from: '2026-02-30' }, ['from']],
      ['invalid to date', { to: 'bad-date' }, ['to']],
      ['unknown method', { method: 'CASH,CRYPTO' }, ['method']],
      ['unknown kind', { kind: 'VOID' }, ['kind']],
      ['limit 0', { limit: '0' }, ['limit']],
      ['limit 51', { limit: '51' }, ['limit']],
      ['fractional limit', { limit: '2.5' }, ['limit']],
      ['tampered cursor', { cursor: 'not-valid-cursor' }, ['cursor']],
    ];

    for (const [label, query, expectedFields] of validationCases) {
      try {
        await service.listLedger(query);
        expect.unreachable(`${label} should throw`);
      } catch (error) {
        expect(error, label).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).fields, label).toEqual(expectedFields);
      }
    }

    // Valid cursor decodes anchor fields into repository filter.
    const validCursor = encodePaymentLedgerCursor({
      paymentDate: '2026-11-25',
      createdAt: CREATED_AT,
      id: PAYMENT_ID,
      from: '2026-11-01',
      to: '2026-11-26',
      methods: '',
      kind: '',
      limit: 20,
    });
    await service.listLedger({ from: '2026-11-01', to: '2026-11-26', cursor: validCursor });
    expect(vi.mocked(repo.listLedger).mock.calls.at(-1)?.[0]).toMatchObject({
      cursorPaymentDate: '2026-11-25',
      cursorCreatedAt: CREATED_AT,
      cursorId: PAYMENT_ID,
    });
  });
});
