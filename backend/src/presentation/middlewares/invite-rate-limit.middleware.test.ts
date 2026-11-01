import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  closeRateLimitStore,
  inviteAcceptRateLimiter,
  invitePreviewRateLimiter,
  inviteWriteRateLimiter,
} from './invite-rate-limit.middleware.js';

/**
 * These tests run against an unreachable Redis on purpose: the spec requires
 * the invitation limiters to fail open, so the in process counter must still
 * cap a flood. The limiters are imported once at the top so the module level
 * Redis client starts early and its connect attempts settle before the first
 * request; the config disabled flag is off by default in tests.
 *
 * Each route belongs to its own test, so one client serves one limiter and the
 * counters of one route can never leak into another.
 */
let server: Server;

/** TEST-NET-3 addresses keep each test's limiter keys isolated. */
let nextIp = 1;
function uniqueIp(): string {
  const ip = `198.51.100.${nextIp}`;
  nextIp += 1;
  return ip;
}

beforeAll(async () => {
  process.env.REDIS_URL = 'redis://127.0.0.1:1';

  const app = express();
  app.set('trust proxy', 1);
  app.use((req, _res, next) => {
    req.user = {
      userId: String(req.header('x-test-user') ?? 'anonymous'),
      memberships: [],
    };
    next();
  });

  app.get('/preview', invitePreviewRateLimiter, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.post('/accept', inviteAcceptRateLimiter, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.post('/write', inviteWriteRateLimiter, (_req, res) => {
    res.status(201).json({ ok: true });
  });

  server = app.listen(0);
  // Give the first connection attempt a moment to fail so every request below
  // takes the fallback path instead of queueing behind it.
  await new Promise((resolve) => setTimeout(resolve, 300));
});

afterAll(async () => {
  await closeRateLimitStore();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('invitation rate limiters', () => {
  it('answers 429 RATE_LIMITED once a preview caller passes thirty a minute', async () => {
    const ip = uniqueIp();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request(server).get('/preview').set('X-Forwarded-For', ip);
      expect(response.status).toBe(200);
    }

    const blocked = await request(server).get('/preview').set('X-Forwarded-For', ip);

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
    });
  });
});
