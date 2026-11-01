import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeRateLimitStore, inviteWriteRateLimiter } from './invite-rate-limit.middleware.js';

/**
 * Invitations and resends share one budget of ten an hour per owner, and one
 * owner's burst never blocks another owner (AC-24).
 */
let server: Server;

beforeAll(async () => {
  process.env.REDIS_URL = 'redis://127.0.0.1:1';

  const app = express();
  app.set('trust proxy', 1);
  app.use((req, _res, next) => {
    req.user = { userId: String(req.header('x-test-user') ?? 'anonymous'), memberships: [] };
    next();
  });
  app.post('/write', inviteWriteRateLimiter, (_req, res) => {
    res.status(201).json({ ok: true });
  });

  server = app.listen(0);
  await new Promise((resolve) => setTimeout(resolve, 300));
});

afterAll(async () => {
  await closeRateLimitStore();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('invite write rate limiter', () => {
  it('allows an owner ten invitations an hour and counts each owner apart', async () => {
    const owner = '198.51.100.21';
    const otherOwner = '198.51.100.22';

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(server)
        .post('/write')
        .set('X-Forwarded-For', owner)
        .set('x-test-user', owner);
      expect(response.status).toBe(201);
    }

    const blocked = await request(server)
      .post('/write')
      .set('X-Forwarded-For', owner)
      .set('x-test-user', owner);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');

    const neighbour = await request(server)
      .post('/write')
      .set('X-Forwarded-For', otherOwner)
      .set('x-test-user', otherOwner);
    expect(neighbour.status).toBe(201);
  });
});
