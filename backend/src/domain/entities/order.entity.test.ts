import { describe, expect, it } from 'vitest';
import {
  EDITABLE_ORDER_STATUSES,
  getStockMovement,
  ORDER_TRANSITIONS,
  OrderStatus,
} from './order.entity.js';

describe('order status rules', () => {
  // covers AC-10: the transition table is the full workflow contract
  it('allows exactly the documented moves from every status', () => {
    expect(ORDER_TRANSITIONS).toEqual({
      PENDING: ['CONFIRMED', 'CANCELLED'],
      CONFIRMED: ['PROCESSING', 'CANCELLED'],
      PROCESSING: ['SHIPPED', 'CANCELLED'],
      SHIPPED: ['DELIVERED', 'RETURNED'],
      DELIVERED: ['RETURNED'],
      CANCELLED: [],
      RETURNED: [],
    });
  });

  // covers AC-9: only pending and confirmed orders can be edited
  it('allows edits only while the order is pending or confirmed', () => {
    expect(EDITABLE_ORDER_STATUSES).toEqual([OrderStatus.PENDING, OrderStatus.CONFIRMED]);
  });

  // covers AC-10: the table answers for every value of the status enum
  it('has a transition row for every status', () => {
    for (const status of Object.values(OrderStatus)) {
      expect(ORDER_TRANSITIONS[status]).toBeDefined();
    }
    expect(Object.values(OrderStatus)).toHaveLength(7);
  });
});

describe('getStockMovement', () => {
  // covers AC-1: confirming a pending order takes stock once
  it('takes stock when an order reaches CONFIRMED', () => {
    expect(getStockMovement(OrderStatus.PENDING, OrderStatus.CONFIRMED)).toBe('sale');
  });

  // covers AC-2: a cancelled confirmed order puts the stock back
  it('restores stock when a CONFIRMED order is cancelled', () => {
    expect(getStockMovement(OrderStatus.CONFIRMED, OrderStatus.CANCELLED)).toBe('restoration');
  });

  // covers AC-3: progress after CONFIRMED never touches stock until a release
  it('leaves stock alone while an order progresses to shipping', () => {
    expect(getStockMovement(OrderStatus.CONFIRMED, OrderStatus.PROCESSING)).toBeNull();
    expect(getStockMovement(OrderStatus.PROCESSING, OrderStatus.SHIPPED)).toBeNull();
    expect(getStockMovement(OrderStatus.SHIPPED, OrderStatus.DELIVERED)).toBeNull();
  });

  // covers AC-3: a return arrives from SHIPPED or DELIVERED, not from CONFIRMED
  it('restores stock when a shipped or delivered order is returned', () => {
    expect(getStockMovement(OrderStatus.SHIPPED, OrderStatus.RETURNED)).toBe('restoration');
    expect(getStockMovement(OrderStatus.DELIVERED, OrderStatus.RETURNED)).toBe('restoration');
  });

  // covers AC-4: cancelling after the sale put stock back too
  it('restores stock when a processing order is cancelled', () => {
    expect(getStockMovement(OrderStatus.PROCESSING, OrderStatus.CANCELLED)).toBe('restoration');
  });

  // covers AC-4: a cancelation that never sold anything restores nothing
  it('leaves stock alone when a pending order is cancelled', () => {
    expect(getStockMovement(OrderStatus.PENDING, OrderStatus.CANCELLED)).toBeNull();
  });

  // covers AC-5: the real delivery path starts at 0 stock and ends where it began
  it('nets zero across a full confirm, ship and return round trip', () => {
    const path: OrderStatus[] = [
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      OrderStatus.PROCESSING,
      OrderStatus.SHIPPED,
      OrderStatus.RETURNED,
    ];
    let net = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(ORDER_TRANSITIONS[path[i]]).toContain(path[i + 1]);
      const movement = getStockMovement(path[i], path[i + 1]);
      if (movement === 'sale') net -= 1;
      if (movement === 'restoration') net += 1;
    }
    expect(net).toBe(0);
  });

  // covers AC-5: every legal transition moves stock in the agreed direction
  it('moves stock in the same direction along any full round trip', () => {
    const path: OrderStatus[] = [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.CANCELLED];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(ORDER_TRANSITIONS[path[i]]).toContain(path[i + 1]);
    }
    expect(getStockMovement(OrderStatus.PENDING, OrderStatus.CONFIRMED)).toBe('sale');
    expect(getStockMovement(OrderStatus.CONFIRMED, OrderStatus.CANCELLED)).toBe('restoration');
  });
});
