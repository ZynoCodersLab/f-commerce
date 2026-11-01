import 'dotenv/config';
import { z } from 'zod';

// An empty value means the variable is unset, matching the .env.example files.
const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.string().default('4000'),
  DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://fcommerce:fcommerce@localhost:5432/fcommerce'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  TEST_DATABASE_URL: optionalUrl,
  JWT_SECRET: z.string().min(32).default('super-secret-jwt-key-replace-in-production'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32)
    .default('super-secret-jwt-refresh-key-replace-in-production'),
  OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
  OAUTH_FACEBOOK_CLIENT_ID: z.string().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // Public origin of the web app. Invite links are built from it, so a wrong
  // value sends every invitation to the wrong place.
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  RESEND_API_KEY: z.string().optional(),
  // The sender line invitations arrive from, for example
  // "F Commerce <team@example.com>". Production requires it.
  EMAIL_FROM: z
    .preprocess((value) => (value === '' ? undefined : value), z.string())
    .default('F Commerce <onboarding@resend.dev>'),
  EMAIL_REPLY_TO: z.string().optional(),
  // Test-only escape hatch for end-to-end suites that create many accounts
  // from one IP. The rate-limit middleware ignores it in production.
  RATE_LIMIT_DISABLED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

/**
 * A development machine may run without an email provider, and the worker then
 * records every invitation as skipped. A deployment may not: an invitation that
 * silently never sends is worse than a server that refuses to start.
 */
export function productionEmailProblems(env: {
  NODE_ENV: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (!env.RESEND_API_KEY?.trim()) {
    problems.push('RESEND_API_KEY is required in production.');
  }
  if (!env.EMAIL_FROM?.trim()) {
    problems.push('EMAIL_FROM is required in production.');
  }
  return problems;
}

const problems = productionEmailProblems(parsed.data);

if (problems.length > 0) {
  console.error('Invalid environment variables:', problems.join(' '));
  process.exit(1);
}

export const config = parsed.data;
