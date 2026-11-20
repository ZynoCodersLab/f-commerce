import type { Server } from 'node:http';
import express from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../../infrastructure/config.js';
import { closeRateLimitStore, getRateLimitRedisClient } from './redis-rate-limit-store.js';
import {
  globalRateLimiter,
  loginAccountRateLimiter,
  loginIpRateLimiter,
  registerRateLimiter,
  uploadRateLimiter,
} from './rate-limit.middleware.js';

const GENERAL_PREFIXES = [
  'ratelimit:global:*',
  'ratelimit:login-ip:*',
  'ratelimit:login-account:*',
  'ratelimit:register:*',
  'ratelimit:refresh:*',
  'ratelimit:upload:*',
];

let server: Server;
let redis: Redis | null = null;
let redisUp = false;

async function clearGeneralKeys(): Promise<void> {
  if (!redis || !redisUp) return;
  for (const pattern of GENERAL_PREFIXES) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

/** TEST-NET-3 addresses keep each test's limiter keys isolated. */
let nextIp = 1;
function uniqueIp(): string {
  const ip = `198.51.100.${nextIp}`;
  nextIp += 1;
  return ip;
}

beforeAll(async () => {
  redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1_000 });
  redis.on('error', () => {
    // Offline runs exercise the in process fallback; silence connection errors.
  });
  redisUp = await redis
    .ping()
    .then(() => true)
    .catch(() => false);
  if (redisUp) {
    const sharedClient = getRateLimitRedisClient();
    if (sharedClient.status !== 'ready') {
      await new Promise<void>((resolve) => sharedClient.once('ready', () => resolve()));
    }
    await clearGeneralKeys();
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(globalRateLimiter);

  app.get('/health', (_request, response) => {
    response.status(200).json({ ok: true });
  });

  app.get('/limited', (_request, response) => {
    response.status(200).json({ ok: true });
  });

  app.post('/login', loginIpRateLimiter, loginAccountRateLimiter, (request, response) => {
    const isValid = request.body?.password === 'correct';
    response.status(isValid ? 200 : 401).json({ ok: isValid });
  });

  app.post('/register', registerRateLimiter, (_request, response) => {
    response.status(201).json({ ok: true });
  });

  app.post(
    '/upload',
    (request, _response, next) => {
      request.user = {
        userId: String(request.header('x-test-user') ?? 'anonymous'),
        memberships: [],
      };
      next();
    },
    uploadRateLimiter,
    (_request, response) => {
      response.status(200).json({ ok: true });
    },
  );

  server = app.listen(0);
});

beforeEach(async () => {
  await clearGeneralKeys();
});

afterAll(async () => {
  await clearGeneralKeys();
  redis?.disconnect();
  await closeRateLimitStore();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('rate limiting', () => {
  it('blocks repeated failed logins from one IP', async () => {
    const ip = uniqueIp();
    const email = `ip-${ip}@example.com`;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(server)
        .post('/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: 'wrong' });

      expect(response.status).toBe(401);
    }

    const blocked = await request(server)
      .post('/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'wrong' });

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
    });
    expect(blocked.headers['ratelimit']).toBeDefined();
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('blocks distributed failures against one account without blocking another', async () => {
    const email = `target-${uniqueIp()}@example.com`;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await request(server)
        .post('/login')
        .set('X-Forwarded-For', uniqueIp())
        .send({ email, password: 'wrong' });

      expect(response.status).toBe(401);
    }

    const blocked = await request(server)
      .post('/login')
      .set('X-Forwarded-For', uniqueIp())
      .send({ email, password: 'wrong' });

    expect(blocked.status).toBe(429);

    const otherAccount = await request(server)
      .post('/login')
      .set('X-Forwarded-For', uniqueIp())
      .send({ email: `other-${uniqueIp()}@example.com`, password: 'wrong' });

    expect(otherAccount.status).toBe(401);
  });

  it('does not count successful sign-ins against the login allowance', async () => {
    const ip = uniqueIp();
    const email = `success-${ip}@example.com`;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await request(server)
        .post('/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: 'correct' });

      expect(response.status).toBe(200);
      // skipSuccessfulRequests decrements on the response finish event.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  it('blocks rapid registration from one IP', async () => {
    const ip = uniqueIp();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(server).post('/register').set('X-Forwarded-For', ip).send({});

      expect(response.status).toBe(201);
    }

    const blocked = await request(server).post('/register').set('X-Forwarded-For', ip).send({});

    expect(blocked.status).toBe(429);
  });

  it('limits uploads per authenticated user instead of per IP', async () => {
    const firstUser = `user-${uniqueIp()}`;
    const secondUser = `user-${uniqueIp()}`;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(server)
        .post('/upload')
        .set('X-Forwarded-For', uniqueIp())
        .set('x-test-user', firstUser)
        .send();

      expect(response.status).toBe(200);
    }

    const blocked = await request(server)
      .post('/upload')
      .set('X-Forwarded-For', uniqueIp())
      .set('x-test-user', firstUser)
      .send();

    expect(blocked.status).toBe(429);

    const otherUser = await request(server)
      .post('/upload')
      .set('X-Forwarded-For', uniqueIp())
      .set('x-test-user', secondUser)
      .send();

    expect(otherUser.status).toBe(200);
  });

  it('limits the API per IP while leaving health probes alone', async () => {
    const ip = uniqueIp();

    for (let requestCount = 0; requestCount < 100; requestCount += 1) {
      const response = await request(server).get('/limited').set('X-Forwarded-For', ip);
      expect(response.status).toBe(200);
    }

    const blocked = await request(server).get('/limited').set('X-Forwarded-For', ip);
    expect(blocked.status).toBe(429);

    // The platform probe must still pass after the IP has exhausted its API quota.
    const health = await request(server).get('/health').set('X-Forwarded-For', ip);
    expect(health.status).toBe(200);
  });
});
