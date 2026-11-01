import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const testIp = '198.51.100.240';

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startRegisterApp(): Promise<Server> {
  const { registerRateLimiter } = await import('./rate-limit.middleware.js');
  const app = express();

  app.post('/register', registerRateLimiter, (_request, response) => {
    response.status(201).json({ ok: true });
  });

  return app.listen(0);
}

afterEach(() => {
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
    // A production process refuses to start without email settings, and the
    // limiter is loaded through the same config module.
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.stubEnv('EMAIL_FROM', 'F Commerce <team@example.com>');

    const server = await startRegisterApp();

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
