import { describe, it, expect } from 'vitest';
import { envSchema, productionAppOriginProblems, productionEmailProblems } from './config.js';

// The tests parse the real schema exported by config.ts, so a new variable
// can never be added to the runtime schema while this contract test keeps
// validating an older copy.

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
        expect(result.data.APP_ORIGIN).toBe('http://localhost:3000');
        expect(result.data.RATE_LIMIT_DISABLED).toBe(false);
        expect(result.data.NODE_ENV).toBe('development');
      }
    });

    it('parses the test only rate limit flag as a boolean', () => {
      const result = envSchema.safeParse({
        PORT: '4000',
        DATABASE_URL: 'postgresql://localhost:5432/test',
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        RATE_LIMIT_DISABLED: 'true',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.RATE_LIMIT_DISABLED).toBe(true);
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

  // These go through the real schema the way config.ts and worker.ts do, so a
  // future default cannot silently defeat the production gate again.
  it('reports a missing sender through the real schema in production', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      RESEND_API_KEY: 're_live',
      EMAIL_FROM: undefined,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.EMAIL_FROM).toBeUndefined();
      expect(productionEmailProblems(result.data)).toEqual([
        'EMAIL_FROM is required in production.',
      ]);
    }
  });

  it('treats an empty sender as unset through the real schema', () => {
    const result = envSchema.safeParse({ NODE_ENV: 'production', EMAIL_FROM: '' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.EMAIL_FROM).toBeUndefined();
    }
  });

  it('does not report a missing sender on a development machine', () => {
    const result = envSchema.safeParse({ NODE_ENV: 'development', EMAIL_FROM: undefined });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(productionEmailProblems(result.data)).toEqual([]);
    }
  });
});

describe('production app origin requirements', () => {
  it('rejects a localhost origin in production', () => {
    expect(
      productionAppOriginProblems({
        NODE_ENV: 'production',
        APP_ORIGIN: 'http://localhost:3000',
      }),
    ).toEqual(['APP_ORIGIN must not point at localhost in production.']);
  });

  it('rejects the loopback aliases in production', () => {
    expect(
      productionAppOriginProblems({
        NODE_ENV: 'production',
        APP_ORIGIN: 'http://127.0.0.1:3000',
      }),
    ).toHaveLength(1);
    expect(
      productionAppOriginProblems({
        NODE_ENV: 'production',
        APP_ORIGIN: 'http://[::1]:3000',
      }),
    ).toHaveLength(1);
  });

  it('accepts a real origin in production', () => {
    expect(
      productionAppOriginProblems({
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://shop.example.com',
      }),
    ).toEqual([]);
  });

  it('never blocks a development machine', () => {
    expect(
      productionAppOriginProblems({
        NODE_ENV: 'development',
        APP_ORIGIN: 'http://localhost:3000',
      }),
    ).toEqual([]);
  });

  it('reports an invalid origin in production', () => {
    expect(
      productionAppOriginProblems({ NODE_ENV: 'production', APP_ORIGIN: 'not-a-url' }),
    ).toEqual(['APP_ORIGIN must be a valid URL in production.']);
  });

  // Goes through the real schema the way config.ts does, so the localhost
  // default can never silently defeat the production gate again.
  it('catches the default localhost origin through the real schema in production', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://localhost:5432/test',
      JWT_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.APP_ORIGIN).toBe('http://localhost:3000');
      expect(productionAppOriginProblems(result.data)).toEqual([
        'APP_ORIGIN must not point at localhost in production.',
      ]);
    }
  });
});
