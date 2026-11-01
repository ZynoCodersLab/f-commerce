import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeRateLimitStore, inviteAcceptRateLimiter } from './invite-rate-limit.middleware.js';

/**
 * The accept limit fails open without Redis and still counts each address
 * apart, so a flood from one visitor never locks out another (AC-24).
 */
let server: Server;

beforeAll(async () => {
  process.env.REDIS_URL = 'redis://127.0.0.1:1';

  const app = express();
  app.set('trust proxy', 1);
  app.post('/accept', inviteAcceptRateLimiter, (_req, res) => {
    res.status(200).json({ ok: true });
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

describe('accept rate limiter', () => {
  it('counts accept attempts per address', async () => {
    const ip = '198.51.100.11';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(server).post('/accept').set('X-Forwarded-For', ip);
      expect(response.status).toBe(200);
    }

    const blocked = await request(server).post('/accept').set('X-Forwarded-For', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('RATE_LIMITED');

    const otherAddress = await request(server)
      .post('/accept')
      .set('X-Forwarded-For', '198.51.100.12');
    expect(otherAddress.status).toBe(200);
  });
});
