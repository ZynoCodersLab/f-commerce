import {
  Payment,
  PaymentKind,
  PaymentLedgerItem,
  PaymentLedgerSummary,
  PaymentMethod,
} from '../entities/financial.entity.js';
import { OrderDetail } from '../entities/order.entity.js';

export interface PaymentWriteData {
  kind: PaymentKind;
  amount: number;
  method: PaymentMethod;
  paymentDate: string;
  referenceNumber: string | null;
  notes: string | null;
  recordedByUserId: string;
  recordedByName: string;
  idempotencyKey: string | null;
}

export interface PaymentAuditWrite {
  businessId: string;
  userId: string;
  action: string;
}

export interface PaymentVoidWrite {
  voidedByUserId: string;
  voidedByName: string;
  reason: string;
}

export interface BusinessPaymentSettings {
  currency: string;
  timezone: string;
}

export interface PaymentLedgerFilter {
  from: string;
  to: string;
  methods: PaymentMethod[];
  kind?: PaymentKind;
  limit: number;
  cursorPaymentDate?: string;
  cursorCreatedAt?: Date;
  cursorId?: string;
}

export interface PaymentLedgerResult {
  items: PaymentLedgerItem[];
  summary: PaymentLedgerSummary;
  hasMore: boolean;
}

export interface IPaymentRepository {
  orderExists(orderId: string): Promise<boolean>;
  findByIdempotencyKey(key: string): Promise<Payment | null>;
  findBusinessSettings(): Promise<BusinessPaymentSettings | null>;
  findActorName(userId: string): Promise<string | null>;
  findOrderDetail(orderId: string): Promise<OrderDetail | null>;
  recordEntry(
    orderId: string,
    entry: PaymentWriteData,
    audit: PaymentAuditWrite,
  ): Promise<OrderDetail>;
  voidEntry(
    orderId: string,
    paymentId: string,
    voidWrite: PaymentVoidWrite,
    audit: PaymentAuditWrite,
  ): Promise<OrderDetail>;
  listLedger(filter: PaymentLedgerFilter): Promise<PaymentLedgerResult>;
}
