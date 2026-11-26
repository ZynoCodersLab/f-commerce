import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import type { Request } from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../infrastructure/config.js';
import { closeRateLimitStore, getRateLimitRedisClient } from './redis-rate-limit-store.js';
import { clearGeneralRateLimitKeys } from './rate-limit.test-helpers.js';
import {
  globalRateLimiter,
  loginAccountRateLimiter,
  loginIpRateLimiter,
  refreshRateLimiter,
  registerRateLimiter,
  uploadRateLimiter,
} from './rate-limit.middleware.js';

let redis: Redis;
let first: Server;
let second: Server;
let redisUp = false;

function buildApp(): Server {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(globalRateLimiter);

  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/ping', (_req, res) => res.status(200).json({ ok: true }));
  app.post('/login', loginIpRateLimiter, loginAccountRateLimiter, (req, res) => {
    const valid = req.body?.password === 'correct';
    res.status(valid ? 200 : 401).json({ ok: valid });
  });
  app.post('/register', registerRateLimiter, (_req, res) => res.status(201).json({ ok: true }));
  app.post('/refresh', refreshRateLimiter, (_req, res) => res.status(200).json({ ok: true }));
  app.post(
    '/upload',
    (req: Request, _res, next) => {
      const userId = req.header('x-user-id');
      if (userId) req.user = { userId, memberships: [] };
      next();
    },
    uploadRateLimiter,
    (_req, res) => res.status(200).json({ ok: true }),
  );

  return app.listen(0);
}

function hashedKey(prefix: string, rawKey: string): string {
  return `ratelimit:${prefix}:${createHash('sha256').update(rawKey).digest('hex')}`;
}

beforeAll(async () => {
  redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1_000 });
  redis.on('error', () => {
    // Skipped cleanly when Redis is not running.
  });
  redisUp = await redis
    .ping()
    .then(() => true)
    .catch(() => false);
  if (!redisUp) {
    console.warn('No Redis reachable, skipping the shared general rate limiter cases.');
    return;
  }

  const sharedClient = getRateLimitRedisClient();
  if (sharedClient.status !== 'ready') {
    await new Promise<void>((resolve) => sharedClient.once('ready', () => resolve()));
  }

  first = buildApp();
  second = buildApp();
});

beforeEach(async () => {
  if (redisUp) await clearGeneralRateLimitKeys(redis);
});

afterAll(async () => {
  if (redisUp) await clearGeneralRateLimitKeys(redis);
  redis?.disconnect();
  await closeRateLimitStore();
  await new Promise<void>((resolve) => (first ? first.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => (second ? second.close(() => resolve()) : resolve()));
});

describe('general rate limiters with shared Redis store', () => {
  it('shares registration counts in Redis across API instances', async () => {
    if (!redisUp) return;
    const ip = '198.51.100.201';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(first).post('/register').set('X-Forwarded-For', ip).send({});
      expect(response.status).toBe(201);
    }

    expect(await redis.get(hashedKey('register', ip))).toBe('5');

    const blocked = await request(second).post('/register').set('X-Forwarded-For', ip).send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');
  });

  it('shares login IP and account counters in Redis and decrements successful logins', async () => {
    if (!redisUp) return;
    const ip = '198.51.100.202';
    const email = 'seller@example.com';

    const okLogin = await request(first)
      .post('/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'correct' });
    expect(okLogin.status).toBe(200);

    // Successful sign-ins decrement the shared Redis counter back to 0.
    await expect.poll(() => redis.get(hashedKey('login-ip', ip)), { timeout: 1000 }).toBe('0');
    await expect
      .poll(() => redis.get(hashedKey('login-account', `login:${email}`)), { timeout: 1000 })
      .toBe('0');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = await request(first)
        .post('/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: 'wrong' });
      expect(failed.status).toBe(401);
    }

    const blocked = await request(second)
      .post('/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');
  });

  it('shares upload and refresh limits in Redis across API instances', async () => {
    if (!redisUp) return;
    const userId = 'user-shared-upload';

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(first)
        .post('/upload')
        .set('X-Forwarded-For', `198.51.100.${210 + attempt}`)
        .set('x-user-id', userId);
      expect(response.status).toBe(200);
    }

    expect(await redis.get(hashedKey('upload', `upload:${userId}`))).toBe('10');

    const blockedUpload = await request(second)
      .post('/upload')
      .set('X-Forwarded-For', '198.51.100.225')
      .set('x-user-id', userId);
    expect(blockedUpload.status).toBe(429);

    const refreshIp = '198.51.100.230';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(first).post('/refresh').set('X-Forwarded-For', refreshIp);
      expect(response.status).toBe(200);
    }

    expect(await redis.get(hashedKey('refresh', refreshIp))).toBe('60');

    const blockedRefresh = await request(second).post('/refresh').set('X-Forwarded-For', refreshIp);
    expect(blockedRefresh.status).toBe(429);
  });

  it('shares the global backstop in Redis while keeping /health untouched', async () => {
    if (!redisUp) return;
    const ip = '198.51.100.235';

    const healthBefore = await request(first).get('/health').set('X-Forwarded-For', ip);
    expect(healthBefore.status).toBe(200);
    expect(await redis.exists(hashedKey('global', ip))).toBe(0);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await request(first).get('/ping').set('X-Forwarded-For', ip);
      expect(response.status).toBe(200);
    }

    expect(await redis.get(hashedKey('global', ip))).toBe('100');

    const blocked = await request(second).get('/ping').set('X-Forwarded-For', ip);
    expect(blocked.status).toBe(429);

    const healthAfter = await request(second).get('/health').set('X-Forwarded-For', ip);
    expect(healthAfter.status).toBe(200);
  });
});
