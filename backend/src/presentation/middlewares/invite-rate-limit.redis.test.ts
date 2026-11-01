import express from 'express';
import request from 'supertest';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';

import { config } from '../../infrastructure/config.js';
import { closeRateLimitStore, inviteAcceptRateLimiter } from './invite-rate-limit.middleware.js';

/**
 * The shared invitation counters live in Redis so every API instance counts
 * the same visitor once, and a Redis outage never blocks a real person
 * (AC-24). These cases talk to a real Redis and skip themselves when none is
 * reachable, so the rest of the suite still runs without Docker.
 */
const PREFIX = 'team-accept';

let redis: Redis;
let first: Server;
let second: Server;
let redisUp = false;

function buildApp(): Server {
  const app = express();
  app.set('trust proxy', 1);
  app.post('/accept', inviteAcceptRateLimiter, (_req, res) => res.status(200).json({ ok: true }));
  return app.listen(0);
}

async function clearPrefix(): Promise<void> {
  const keys = await redis.keys(`ratelimit:${PREFIX}:*`);
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

afterAll(async () => {
  if (redisUp) await clearPrefix();
  redis?.disconnect();
  await closeRateLimitStore();
  await new Promise<void>((resolve) => (first ? first.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) => (second ? second.close(() => resolve()) : resolve()));
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
