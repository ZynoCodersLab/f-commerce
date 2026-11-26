import { Request, Response, Router } from 'express';
import {
  OrderCreateSchema,
  OrderStatusChangeSchema,
  OrderUpdateSchema,
  PaymentCreateSchema,
  PaymentVoidSchema,
} from '@f-commerce/contracts';
import { OrderService } from '../../application/services/order.service.js';
import { PaymentService } from '../../application/services/payment.service.js';
import { requireAuth, requireBusinessRole } from '../middlewares/auth.middleware.js';
import { DrizzleOrderRepository } from '../../infrastructure/database/drizzle/repositories/order.repository.js';
import { DrizzlePaymentRepository } from '../../infrastructure/database/drizzle/repositories/payment.repository.js';
import { getTenantId } from '../../infrastructure/database/drizzle/context.js';
import { PaymentKind } from '../../domain/entities/financial.entity.js';
import { isUuid } from '../../domain/uuid.js';
import { sendInternalError } from './internal-error.js';
import {
  CustomerArchivedError,
  DomainError,
  DuplicateOrderError,
  IdempotencyKeyConflictError,
  InvalidStatusTransitionError,
  NotFoundError,
  OrderChangedError,
  OrderClosedError,
  OrderLockedError,
  PaymentAlreadyVoidedError,
  PaymentExceedsDueError,
  RefundExceedsPaidError,
  TotalBelowPaidError,
  ValidationError,
  VoidBreaksBalanceError,
} from '../../domain/errors.js';

export const orderRouter = Router();

const orderService = new OrderService(new DrizzleOrderRepository());
const paymentService = new PaymentService(new DrizzlePaymentRepository());
const ALLOWED_ROLES: ('OWNER' | 'STAFF')[] = ['OWNER', 'STAFF'];
const OWNER_ONLY: ('OWNER' | 'STAFF')[] = ['OWNER'];

function invalidFields(issues: { path: PropertyKey[] }[]): string[] {
  return Array.from(
    new Set(
      issues.map((issue) => {
        const first = String(issue.path[0] ?? '');
        if (first === 'initialPayment' && issue.path.length > 1) {
          return `${first}.${String(issue.path[1])}`;
        }
        return first;
      }),
    ),
  ).filter((field) => field !== '');
}

/** Map a domain error to the order and payment error contract. */
export function sendOrderError(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: error.message,
      fields: error.fields,
    });
    return;
  }

  if (error instanceof DuplicateOrderError) {
    res.status(409).json({
      error: 'DUPLICATE_ORDER',
      message: error.message,
      existingOrder: {
        id: error.existingOrder.id,
        orderNumber: error.existingOrder.orderNumber,
        status: error.existingOrder.status,
        total: error.existingOrder.total,
        createdAt: error.existingOrder.createdAt.toISOString(),
      },
    });
    return;
  }

  if (error instanceof CustomerArchivedError) {
    res.status(409).json({ error: 'CUSTOMER_ARCHIVED', message: error.message });
    return;
  }

  if (error instanceof OrderLockedError) {
    res.status(409).json({ error: 'ORDER_LOCKED', message: error.message });
    return;
  }

  if (error instanceof OrderChangedError) {
    res.status(409).json({ error: 'ORDER_CHANGED', message: error.message });
    return;
  }

  if (error instanceof InvalidStatusTransitionError) {
    res.status(409).json({ error: 'INVALID_STATUS_TRANSITION', message: error.message });
    return;
  }

  if (error instanceof OrderClosedError) {
    res.status(409).json({ error: 'ORDER_CLOSED', message: error.message });
    return;
  }

  if (error instanceof PaymentExceedsDueError) {
    res.status(409).json({
      error: 'PAYMENT_EXCEEDS_DUE',
      message: error.message,
      dueAmount: error.dueAmount,
    });
    return;
  }

  if (error instanceof RefundExceedsPaidError) {
    res.status(409).json({
      error: 'REFUND_EXCEEDS_PAID',
      message: error.message,
      paidAmount: error.paidAmount,
    });
    return;
  }

  if (error instanceof PaymentAlreadyVoidedError) {
    res.status(409).json({ error: 'PAYMENT_ALREADY_VOIDED', message: error.message });
    return;
  }

  if (error instanceof VoidBreaksBalanceError) {
    res.status(409).json({
      error: 'VOID_BREAKS_BALANCE',
      message: error.message,
      paidAmount: error.paidAmount,
      total: error.total,
    });
    return;
  }

  if (error instanceof TotalBelowPaidError) {
    res.status(409).json({
      error: 'TOTAL_BELOW_PAID',
      message: error.message,
      paidAmount: error.paidAmount,
    });
    return;
  }

  if (error instanceof IdempotencyKeyConflictError) {
    res.status(409).json({ error: 'IDEMPOTENCY_KEY_CONFLICT', message: error.message });
    return;
  }

  if (error instanceof NotFoundError) {
    res.status(404).json({ error: 'NOT_FOUND', message: error.message });
    return;
  }

  if (error instanceof DomainError) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message: error.message });
    return;
  }

  sendInternalError(res, error);
}

function actorFromContext(req: Request) {
  const businessId = getTenantId();
  if (!businessId) {
    throw new NotFoundError('No business context');
  }
  const user = req.user as { userId?: string } | undefined;
  return { businessId, userId: user?.userId ?? '' };
}

/** Express types a route param as string or string[]; take the first value. */
function paramValue(req: Request, name: string): string {
  const raw = req.params[name];
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseIdempotencyHeader(req: Request): string | null {
  const rawKey = req.get('Idempotency-Key');
  if (rawKey === undefined) return null;
  const trimmed = rawKey.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new ValidationError(['Idempotency-Key']);
  }
  return trimmed;
}

orderRouter.use(requireAuth);

orderRouter.post('/', requireBusinessRole(ALLOWED_ROLES), async (req: Request, res: Response) => {
  try {
    const idempotencyKey = parseIdempotencyHeader(req);
    if (idempotencyKey !== null) {
      // A replay answers before body validation, reference checks, or the duplicate check.
      const existing = await orderService.findIdempotent(idempotencyKey);
      if (existing) {
        res.status(200).json({ success: true, data: existing, message: 'Order retrieved' });
        return;
      }
    }

    const parsed = OrderCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(invalidFields(parsed.error.issues));
    }

    const result = await orderService.create(parsed.data, actorFromContext(req), idempotencyKey);
    res.status(result.replayed ? 200 : 201).json({
      success: true,
      data: result.order,
      message: result.replayed ? 'Order retrieved' : 'Order created',
    });
  } catch (error) {
    sendOrderError(res, error);
  }
});

orderRouter.get('/', requireBusinessRole(ALLOWED_ROLES), async (req: Request, res: Response) => {
  try {
    const page = await orderService.list(
      queryString(req.query.status),
      queryString(req.query.q),
      queryString(req.query.limit),
      queryString(req.query.cursor),
      queryString(req.query.paymentStatus),
    );
    res.status(200).json({ success: true, data: page, message: 'Orders retrieved' });
  } catch (error) {
    sendOrderError(res, error);
  }
});

orderRouter.get('/:id', requireBusinessRole(ALLOWED_ROLES), async (req: Request, res: Response) => {
  try {
    const order = await orderService.get(paramValue(req, 'id'));
    res.status(200).json({ success: true, data: order, message: 'Order retrieved' });
  } catch (error) {
    sendOrderError(res, error);
  }
});

orderRouter.patch(
  '/:id',
  requireBusinessRole(ALLOWED_ROLES),
  async (req: Request, res: Response) => {
    try {
      const parsed = OrderUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(invalidFields(parsed.error.issues));
      }

      const updated = await orderService.update(
        paramValue(req, 'id'),
        parsed.data,
        actorFromContext(req),
      );
      res.status(200).json({ success: true, data: updated, message: 'Order updated' });
    } catch (error) {
      sendOrderError(res, error);
    }
  },
);

orderRouter.post(
  '/:id/status',
  requireBusinessRole(ALLOWED_ROLES),
  async (req: Request, res: Response) => {
    try {
      const parsed = OrderStatusChangeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(invalidFields(parsed.error.issues));
      }

      const updated = await orderService.changeStatus(
        paramValue(req, 'id'),
        parsed.data,
        actorFromContext(req),
      );
      res.status(200).json({ success: true, data: updated, message: 'Order status updated' });
    } catch (error) {
      sendOrderError(res, error);
    }
  },
);

orderRouter.post(
  '/:id/payments',
  requireBusinessRole(ALLOWED_ROLES),
  async (req: Request, res: Response) => {
    try {
      const idempotencyKey = parseIdempotencyHeader(req);
      const orderId = paramValue(req, 'id');

      const existing = await paymentService.ensureOrderAndCheckIdempotency(
        orderId,
        PaymentKind.PAYMENT,
        idempotencyKey,
      );
      if (existing) {
        res.status(200).json({ success: true, data: existing, message: 'Payment retrieved' });
        return;
      }

      const parsed = PaymentCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(invalidFields(parsed.error.issues));
      }

      const result = await paymentService.recordPayment(
        orderId,
        parsed.data,
        actorFromContext(req),
        idempotencyKey,
      );
      res.status(result.replayed ? 200 : 201).json({
        success: true,
        data: result.order,
        message: result.replayed ? 'Payment retrieved' : 'Payment recorded',
      });
    } catch (error) {
      sendOrderError(res, error);
    }
  },
);

orderRouter.post(
  '/:id/refunds',
  requireBusinessRole(OWNER_ONLY),
  async (req: Request, res: Response) => {
    try {
      const idempotencyKey = parseIdempotencyHeader(req);
      const orderId = paramValue(req, 'id');

      const existing = await paymentService.ensureOrderAndCheckIdempotency(
        orderId,
        PaymentKind.REFUND,
        idempotencyKey,
      );
      if (existing) {
        res.status(200).json({ success: true, data: existing, message: 'Refund retrieved' });
        return;
      }

      const parsed = PaymentCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(invalidFields(parsed.error.issues));
      }

      const result = await paymentService.recordRefund(
        orderId,
        parsed.data,
        actorFromContext(req),
        idempotencyKey,
      );
      res.status(result.replayed ? 200 : 201).json({
        success: true,
        data: result.order,
        message: result.replayed ? 'Refund retrieved' : 'Refund recorded',
      });
    } catch (error) {
      sendOrderError(res, error);
    }
  },
);

orderRouter.post(
  '/:id/payments/:paymentId/void',
  requireBusinessRole(OWNER_ONLY),
  async (req: Request, res: Response) => {
    try {
      const orderId = paramValue(req, 'id');
      const paymentId = paramValue(req, 'paymentId');
      if (!isUuid(orderId) || !isUuid(paymentId)) {
        throw new NotFoundError('Payment not found');
      }

      const parsed = PaymentVoidSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(invalidFields(parsed.error.issues));
      }

      const updated = await paymentService.voidPayment(
        orderId,
        paymentId,
        parsed.data,
        actorFromContext(req),
      );
      res.status(200).json({ success: true, data: updated, message: 'Payment voided' });
    } catch (error) {
      sendOrderError(res, error);
    }
  },
);
