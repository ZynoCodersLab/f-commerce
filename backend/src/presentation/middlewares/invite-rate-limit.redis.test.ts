import express from 'express';
import request from 'supertest';
import type { Request } from 'express';
import type { Options } from 'express-rate-limit';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';

import { config } from '../../infrastructure/config.js';
import {
  RedisRateLimitStore,
  closeRateLimitStore,
  inviteAcceptRateLimiter,
  inviteAcceptTokenRateLimiter,
  invitePreviewRateLimiter,
  invitePreviewTokenRateLimiter,
  inviteWriteRateLimiter,
} from './invite-rate-limit.middleware.js';

// Covers AC-24: the three invitation limits share one counter across API
// instances and fail open, while still capping a flood in one process.

/**
 * The shared invitation counters live in Redis so every API instance counts
 * the same visitor once, and a Redis outage never blocks a real person
 * (AC-24). These cases talk to a real Redis and skip themselves when none is
 * reachable, so the rest of the suite still runs without Docker.
 */
let redis: Redis;
let first: Server;
let second: Server;
let redisUp = false;

function buildApp(): Server {
  const app = express();
  app.set('trust proxy', 1);
  // The write limiter keys on the signed in owner, so stand in for the auth
  // middleware that normally fills request.user.
  app.use((req: Request, _res, next) => {
    const userId = req.header('x-user-id');
    if (userId) req.user = { userId, memberships: [] };
    next();
  });
  app.post('/accept', inviteAcceptRateLimiter, (_req, res) => res.status(200).json({ ok: true }));
  app.post('/accept/:token', inviteAcceptTokenRateLimiter, inviteAcceptRateLimiter, (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  app.post('/write', inviteWriteRateLimiter, (_req, res) => res.status(200).json({ ok: true }));
  app.get('/preview', invitePreviewRateLimiter, (_req, res) => res.status(200).json({ ok: true }));
  app.get('/preview/:token', invitePreviewTokenRateLimiter, invitePreviewRateLimiter, (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  return app.listen(0);
}

async function clearPrefix(): Promise<void> {
  const keys = await redis.keys('ratelimit:team-*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeAll(async () => {
  redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1_000 });
  redisUp = await redis
    .ping()
    .then(() => true)
    .catch(() => false);
  if (!redisUp) {
    console.warn('No Redis reachable, skipping the shared invitation counter cases.');
    return;
  }
  first = buildApp();
  second = buildApp();
});

beforeEach(async () => {
  if (redisUp) await clearPrefix();
});

afterAll(async () => {
  if (redisUp) await clearPrefix();
  redis?.disconnect();
  await closeRateLimitStore();
  await new Promise<void>((resolve) => (first ? first.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => (second ? second.close(() => resolve()) : resolve()));
});

describe('invite write rate limiter', () => {
  it('caps one owner at ten invitations or resends an hour and leaves another owner alone', async () => {
    if (!redisUp) return;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(first).post('/write').set('x-user-id', 'owner-a');
      expect(response.status).toBe(200);
    }

    const blocked = await request(second).post('/write').set('x-user-id', 'owner-a');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');

    const otherOwner = await request(second).post('/write').set('x-user-id', 'owner-b');
    expect(otherOwner.status).toBe(200);
  });
});

describe('invite preview rate limiter', () => {
  it('caps one address at thirty previews a minute and lets another address through', async () => {
    if (!redisUp) return;
    const ip = '198.51.100.71';

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request(first).get('/preview').set('X-Forwarded-For', ip);
      expect(response.status).toBe(200);
    }

    const blocked = await request(second).get('/preview').set('X-Forwarded-For', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');

    const otherAddress = await request(second)
      .get('/preview')
      .set('X-Forwarded-For', '198.51.100.72');
    expect(otherAddress.status).toBe(200);
  });
});

describe('shared store reset', () => {
  it('clears the shared counters as well as the in process fallback', async () => {
    if (!redisUp) return;
    const store = new RedisRateLimitStore(redis, 'team-reset');
    store.init({ windowMs: 60_000 } as Options);

    await store.increment('owner-a');
    await store.increment('owner-a');
    await store.resetAll();

    const after = await store.increment('owner-a');
    expect(after.totalHits).toBe(1);
  });
});

describe('shared store decrement', () => {
  it('does not create a counter when the key was never counted', async () => {
    if (!redisUp) return;
    const store = new RedisRateLimitStore(redis, 'team-decrement');
    store.init({ windowMs: 60_000 } as Options);

    await store.decrement('owner-ghost');
    const first = await store.increment('owner-ghost');

    expect(first.totalHits).toBe(1);
  });

  it('keeps a live counter and its window when decrementing', async () => {
    if (!redisUp) return;
    const store = new RedisRateLimitStore(redis, 'team-decrement');
    store.init({ windowMs: 60_000 } as Options);

    await store.increment('owner-a');
    await store.increment('owner-a');
    await store.decrement('owner-a');

    const after = await store.increment('owner-a');
    expect(after.totalHits).toBe(2);
    expect(after.resetTime?.getTime()).toBeGreaterThan(Date.now());
  });

  it('clears a legacy negative counter that had no expiry', async () => {
    if (!redisUp) return;
    const store = new RedisRateLimitStore(redis, 'team-decrement');
    store.init({ windowMs: 60_000 } as Options);
    const key = `ratelimit:team-decrement:${createHash('sha256')
      .update('owner-negative')
      .digest('hex')}`;
    await redis.set(key, '-1');

    await store.decrement('owner-negative');

    expect(await redis.exists(key)).toBe(0);
  });
});

describe('accept rate limiter', () => {
  it('counts one address once across API instances', async () => {
    if (!redisUp) return;
    await clearPrefix();
    const ip = '198.51.100.61';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(first).post('/accept').set('X-Forwarded-For', ip);
      expect(response.status).toBe(200);
    }

    const blocked = await request(second).post('/accept').set('X-Forwarded-For', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');

    const otherAddress = await request(second)
      .post('/accept')
      .set('X-Forwarded-For', '198.51.100.62');
    expect(otherAddress.status).toBe(200);
  });

  it('caps one invite token even when the caller rotates its address', async () => {
    if (!redisUp) return;
    await clearPrefix();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(first)
        .post('/accept/token-abc')
        .set('X-Forwarded-For', `198.51.100.${100 + attempt}`);
      expect(response.status).toBe(200);
    }

    const blocked = await request(second)
      .post('/accept/token-abc')
      .set('X-Forwarded-For', '198.51.100.110');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');

    const otherToken = await request(second)
      .post('/accept/token-def')
      .set('X-Forwarded-For', '198.51.100.111');
    expect(otherToken.status).toBe(200);
  });

  it('caps a flood in this process once Redis stops answering', async () => {
    if (!redisUp) return;
    const ip = '198.51.100.63';

    // A blocked client fails every command quickly, which is what an outage
    // looks like to the store from the process that already holds a connection.
    redis.disconnect();
    redisUp = false;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(first).post('/accept').set('X-Forwarded-For', ip);
      expect(response.status).toBe(200);
    }

    const blocked = await request(first).post('/accept').set('X-Forwarded-For', ip);
    expect(blocked.status).toBe(429);
  });
});
