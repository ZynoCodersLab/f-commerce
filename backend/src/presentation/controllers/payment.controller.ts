import { Request, Response, Router } from 'express';
import { PaymentService } from '../../application/services/payment.service.js';
import { DrizzlePaymentRepository } from '../../infrastructure/database/drizzle/repositories/payment.repository.js';
import { requireAuth, requireBusinessRole } from '../middlewares/auth.middleware.js';
import { sendOrderError } from './order.controller.js';

export const paymentRouter = Router();

const paymentService = new PaymentService(new DrizzlePaymentRepository());
const ALLOWED_ROLES: ('OWNER' | 'STAFF')[] = ['OWNER', 'STAFF'];

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

paymentRouter.use(requireAuth);

paymentRouter.get('/', requireBusinessRole(ALLOWED_ROLES), async (req: Request, res: Response) => {
  try {
    const page = await paymentService.listLedger({
      from: queryString(req.query.from),
      to: queryString(req.query.to),
      method: queryString(req.query.method),
      kind: queryString(req.query.kind),
      limit: queryString(req.query.limit),
      cursor: queryString(req.query.cursor),
    });
    res.status(200).json({ success: true, data: page, message: 'Payments retrieved' });
  } catch (error) {
    sendOrderError(res, error);
  }
});
