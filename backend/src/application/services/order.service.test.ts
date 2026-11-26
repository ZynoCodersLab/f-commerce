import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderStatusChangeRequest } from '@f-commerce/contracts';
import type { OrderDetail, OrderItem } from '../../domain/entities/order.entity.js';
import { OrderStatus } from '../../domain/entities/order.entity.js';
import type { IOrderRepository } from '../../domain/repositories/order.repository.js';
import { OrderService } from './order.service.js';

// Covers AC-1 to AC-4 at the service boundary: which stock moves are handed to
// the repository, which runs them in the same transaction as the status write.

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';

function line(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: crypto.randomUUID(),
    businessId: BUSINESS_ID,
    orderId: ORDER_ID,
    productId: crypto.randomUUID(),
    variantId: undefined,
    productNameSnapshot: 'Shirt',
    variantLabelSnapshot: undefined,
    priceSnapshot: 500,
    costSnapshot: 200,
    quantity: 2,
    subtotal: 1000,
    position: 0,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  };
}

function detail(status: OrderStatus, items: OrderItem[]): OrderDetail {
  return {
    order: {
      id: ORDER_ID,
      businessId: BUSINESS_ID,
      customerId: null,
      orderNumber: 'ORD-0001',
      status,
      customerNameSnapshot: 'Maya',
      customerPhoneSnapshot: '01700000000',
      subtotal: 1000,
      deliveryFee: 0,
      discount: 0,
      total: 1000,
      paidAmount: 0,
      dueAmount: 1000,
      version: 3,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    },
    items,
    history: [],
    payments: [],
  } as unknown as OrderDetail;
}

function repositoryFor(current: OrderDetail): IOrderRepository {
  return {
    findDetailById: vi.fn().mockResolvedValue(current),
    findActorName: vi.fn().mockResolvedValue('Maya'),
    changeStatus: vi.fn().mockResolvedValue(current),
  } as unknown as IOrderRepository;
}

function change(status: OrderStatus): OrderStatusChangeRequest {
  return { status, version: 3, note: null } as unknown as OrderStatusChangeRequest;
}

const actor = { businessId: BUSINESS_ID, userId: crypto.randomUUID() };

function movesOf(repository: IOrderRepository) {
  return vi.mocked(repository.changeStatus).mock.calls[0][4];
}

describe('OrderService.changeStatus stock', () => {
  let lines: OrderItem[];

  beforeEach(() => {
    lines = [line({ quantity: 2 }), line({ quantity: 1, variantId: crypto.randomUUID() })];
  });

  it('takes stock for every line when a pending order is confirmed', async () => {
    const repository = repositoryFor(detail(OrderStatus.PENDING, lines));
    const service = new OrderService(repository);

    await service.changeStatus(ORDER_ID, change(OrderStatus.CONFIRMED), actor);

    expect(movesOf(repository)).toEqual([
      { kind: 'sale', productId: lines[0].productId, variantId: null, quantity: 2 },
      { kind: 'sale', productId: lines[1].productId, variantId: lines[1].variantId, quantity: 1 },
    ]);
  });

  it('puts the same stock back when a confirmed order is cancelled', async () => {
    const repository = repositoryFor(detail(OrderStatus.CONFIRMED, lines));
    const service = new OrderService(repository);

    await service.changeStatus(ORDER_ID, change(OrderStatus.CANCELLED), actor);

    expect(movesOf(repository)).toEqual([
      { kind: 'restoration', productId: lines[0].productId, variantId: null, quantity: 2 },
      {
        kind: 'restoration',
        productId: lines[1].productId,
        variantId: lines[1].variantId,
        quantity: 1,
      },
    ]);
  });

  it('leaves stock alone when an unconfirmed order is cancelled', async () => {
    const repository = repositoryFor(detail(OrderStatus.PENDING, lines));
    const service = new OrderService(repository);

    await service.changeStatus(ORDER_ID, change(OrderStatus.CANCELLED), actor);

    expect(movesOf(repository)).toEqual([]);
  });

  it('puts the same stock back when a shipped order is returned', async () => {
    const repository = repositoryFor(detail(OrderStatus.SHIPPED, lines));
    const service = new OrderService(repository);

    await service.changeStatus(ORDER_ID, change(OrderStatus.RETURNED), actor);

    expect(movesOf(repository)).toEqual([
      { kind: 'restoration', productId: lines[0].productId, variantId: null, quantity: 2 },
      {
        kind: 'restoration',
        productId: lines[1].productId,
        variantId: lines[1].variantId,
        quantity: 1,
      },
    ]);
  });

  it('leaves stock alone while a confirmed order moves through processing', async () => {
    const repository = repositoryFor(detail(OrderStatus.CONFIRMED, lines));
    const service = new OrderService(repository);

    await service.changeStatus(ORDER_ID, change(OrderStatus.PROCESSING), actor);

    expect(movesOf(repository)).toEqual([]);
  });
});
