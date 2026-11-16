import { z } from 'zod';

/** Stored addresses are trimmed and lowercased so casing never splits an account (AC-18). */
const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email('Invalid email format').max(254));

export const RegisterSchema = z.object({
  email: EmailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1, 'Name is required'),
  businessName: z.string().min(1, 'Business name is required'),
});

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, 'Password is required'),
});

export const OAuthLoginSchema = z.object({
  email: EmailSchema,
  name: z.string().min(1, 'Name is required'),
  providerId: z.string().min(1, 'Provider ID is required'),
});

export type RegisterRequest = z.infer<typeof RegisterSchema>;
export type LoginRequest = z.infer<typeof LoginSchema>;
export type OAuthLoginRequest = z.infer<typeof OAuthLoginSchema>;
