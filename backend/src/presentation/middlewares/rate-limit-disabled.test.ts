import type { Server } from 'node:http';
import express from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const testIp = '198.51.100.240';
let closeStore: (() => Promise<void>) | null = null;

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function clearRegisterKeys(redisUrl: string): Promise<boolean> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 1_000 });
  redis.on('error', () => {
    // Offline runs use the in process fallback.
  });
  try {
    const up = await redis
      .ping()
      .then(() => true)
      .catch(() => false);
    if (!up) return false;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'ratelimit:register:*', 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
    return true;
  } finally {
    redis.disconnect();
  }
}

async function startRegisterApp(prepareRedis = false): Promise<Server> {
  const { registerRateLimiter } = await import('./rate-limit.middleware.js');
  const { closeRateLimitStore, getRateLimitRedisClient } =
    await import('./redis-rate-limit-store.js');
  const { config } = await import('../../infrastructure/config.js');
  closeStore = closeRateLimitStore;

  if (prepareRedis && (await clearRegisterKeys(config.REDIS_URL))) {
    const client = getRateLimitRedisClient();
    if (client.status !== 'ready') {
      await new Promise<void>((resolve) => client.once('ready', () => resolve()));
    }
  }

  const app = express();
  app.set('trust proxy', 1);

  app.post('/register', registerRateLimiter, (_request, response) => {
    response.status(201).json({ ok: true });
  });

  return app.listen(0);
}

afterEach(async () => {
  if (closeStore) {
    await closeStore();
    closeStore = null;
  }
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('rate limiter escape hatch', () => {
  it('passes requests through when disabled outside production', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('RATE_LIMIT_DISABLED', 'true');

    const server = await startRegisterApp();

    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await request(server)
          .post('/register')
          .set('X-Forwarded-For', testIp)
          .send({});

        expect(response.status).toBe(201);
      }
    } finally {
      await closeServer(server);
    }
  });

  it('stays enabled in production even when the flag is set', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RATE_LIMIT_DISABLED', 'true');
    // A production process refuses to start without email settings and a real
    // invite origin, and the limiter is loaded through the same config module.
    vi.stubEnv('APP_ORIGIN', 'https://shop.example.com');
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.stubEnv('EMAIL_FROM', 'F Commerce <team@example.com>');

    const server = await startRegisterApp(true);

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await request(server)
          .post('/register')
          .set('X-Forwarded-For', testIp)
          .send({});

        expect(response.status).toBe(201);
      }

      const blocked = await request(server)
        .post('/register')
        .set('X-Forwarded-For', testIp)
        .send({});

      expect(blocked.status).toBe(429);
    } finally {
      await closeServer(server);
    }
  });
});
