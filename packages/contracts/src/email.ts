import { z } from 'zod';

/**
 * An account or invitation email address: trimmed and lowercased before
 * validation so casing or surrounding spaces never split an account or
 * create duplicate invitations (AC-18).
 */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email('Enter a valid email address').max(254));
