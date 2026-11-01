import { z } from 'zod';

export const healthResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ status: z.literal('ok') }),
  message: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './auth.js';
export * from './business.js';
export * from './customer.js';
export * from './order.js';
export * from './product.js';
export * from './team.js';
