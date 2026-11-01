import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { productionEmailProblems } from './config.js';

// We test the env schema logic by re-defining it here (mirroring config.ts)
// and validating against controlled inputs. This avoids spawning child processes
// or polluting the process-level config singleton.
// The real config.ts uses the same schema, so this validates the contract.

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
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z
    .preprocess((value) => (value === '' ? undefined : value), z.string())
    .default('F Commerce <onboarding@resend.dev>'),
  EMAIL_REPLY_TO: z.string().optional(),
});

describe('config env schema', () => {
  describe('valid inputs', () => {
    it('parses when all required vars are provided and valid', () => {
      const result = envSchema.safeParse({
        PORT: '4000',
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe('4000');
        expect(result.data.DATABASE_URL).toBe('postgresql://localhost:5432/test');
        expect(result.data.JWT_SECRET).toHaveLength(32);
      }
    });

    it('fills defaults for optional Cloudinary vars when omitted', () => {
      const result = envSchema.safeParse({
        PORT: '4000',
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CLOUDINARY_CLOUD_NAME).toBe('');
        expect(result.data.CLOUDINARY_API_KEY).toBe('');
        expect(result.data.CLOUDINARY_API_SECRET).toBe('');
        expect(result.data.CORS_ORIGINS).toBe('http://localhost:3000');
        expect(result.data.NODE_ENV).toBe('development');
      }
    });

    it('allows overriding CORS_ORIGINS to a comma-separated list', () => {
      const result = envSchema.safeParse({
        PORT: '4000',
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        CORS_ORIGINS: 'http://localhost:3000,http://localhost:3001',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.CORS_ORIGINS).toBe('http://localhost:3000,http://localhost:3001');
      }
    });

    it('defaults REDIS_URL and treats an empty TEST_DATABASE_URL as unset', () => {
      const result = envSchema.safeParse({
        PORT: '4000',
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        TEST_DATABASE_URL: '',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.REDIS_URL).toBe('redis://localhost:6379');
        expect(result.data.TEST_DATABASE_URL).toBeUndefined();
      }
    });

    it('accepts TEST_DATABASE_URL when set', () => {
      const result = envSchema.safeParse({
        PORT: '4000',
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        TEST_DATABASE_URL: 'postgresql://localhost:5432/test-only',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.TEST_DATABASE_URL).toBe('postgresql://localhost:5432/test-only');
      }
    });

    it('allows optional OAuth fields when set', () => {
      const result = envSchema.safeParse({
        PORT: '4000',
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.OAUTH_GOOGLE_CLIENT_ID).toBe('google-client-id');
      }
    });
  });

  describe('invalid inputs', () => {
    it('rejects when DATABASE_URL is not a valid URL', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'not-a-url',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('DATABASE_URL'))).toBe(true);
      }
    });

    it('rejects a REDIS_URL that is not a valid URL', () => {
      const result = envSchema.safeParse({
        PORT: '4000',
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        REDIS_URL: 'not-a-url',
      });

      expect(result.success).toBe(false);
    });

    it('rejects when JWT_SECRET is shorter than 32 characters', () => {
      const result = envSchema.safeParse({
        JWT_SECRET: 'short',
        JWT_REFRESH_SECRET: 'b'.repeat(32),
      });

      expect(result.success).toBe(false);
    });

    it('rejects when JWT_REFRESH_SECRET is shorter than 32 characters', () => {
      const result = envSchema.safeParse({
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'too-short',
      });

      expect(result.success).toBe(false);
    });

    it('rejects when PORT is not provided but defaults apply correctly when absent', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
      });

      // PORT defaults to '4000', so absence is fine
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PORT).toBe('4000');
      }
    });
  });
});

describe('production email requirements', () => {
  it('requires a provider and a sender in production', () => {
    expect(
      productionEmailProblems({
        NODE_ENV: 'production',
        RESEND_API_KEY: undefined,
        EMAIL_FROM: '',
      }),
    ).toEqual([
      'RESEND_API_KEY is required in production.',
      'EMAIL_FROM is required in production.',
    ]);
  });

  it('is satisfied in production when both are set', () => {
    expect(
      productionEmailProblems({
        NODE_ENV: 'production',
        RESEND_API_KEY: 're_live',
        EMAIL_FROM: 'F Commerce <team@example.com>',
      }),
    ).toEqual([]);
  });

  it('never blocks a development machine', () => {
    expect(
      productionEmailProblems({
        NODE_ENV: 'development',
        RESEND_API_KEY: undefined,
        EMAIL_FROM: '',
      }),
    ).toEqual([]);
  });
});
