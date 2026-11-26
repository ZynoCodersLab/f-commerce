import { TenantEntity } from './base.entity.js';

export enum PaymentMethod {
  CASH = 'CASH',
  CASH_ON_DELIVERY = 'CASH_ON_DELIVERY',
  BKASH = 'BKASH',
  NAGAD = 'NAGAD',
  BANK_TRANSFER = 'BANK_TRANSFER',
  CARD = 'CARD',
  PAYPAL = 'PAYPAL',
  OTHER = 'OTHER',
}

export enum PaymentKind {
  PAYMENT = 'PAYMENT',
  REFUND = 'REFUND',
}

export interface Payment extends TenantEntity {
  orderId: string;
  kind: PaymentKind;
  amount: number;
  method: PaymentMethod;
  referenceNumber?: string;
  notes?: string;
  /** Business calendar day (`YYYY-MM-DD`), never a timestamp. */
  paymentDate: string;
  recordedByUserId: string;
  recordedByName: string;
  voidedAt?: Date;
  voidedByUserId?: string;
  voidedByName?: string;
  voidReason?: string;
  idempotencyKey?: string;
}

/** One entry in the business wide payments ledger, joined to its order summary. */
export interface PaymentLedgerItem extends Payment {
  orderNumber: string;
  customerNameSnapshot: string;
}

export interface PaymentLedgerSummary {
  collected: number;
  refunded: number;
  net: number;
}

export interface ExpenseCategory extends TenantEntity {
  name: string;
  description?: string;
}

export interface Expense extends TenantEntity {
  categoryId?: string;
  amount: number;
  date: Date;
  referenceNumber?: string;
  notes?: string;
}
