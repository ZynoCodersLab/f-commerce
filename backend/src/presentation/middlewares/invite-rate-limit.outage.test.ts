import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Options } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { createRateLimitRedisClient, RedisRateLimitStore } from './invite-rate-limit.middleware.js';

// The limiter must fail open without waiting for ioredis to reconnect. A
// queued command used to wait through the growing reconnect backoff, which
// delayed previews for seconds and an invite create for almost fifteen.

const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:6398';

describe('invite rate limiter when Redis is unreachable', () => {
  let client: Redis | undefined;

  afterEach(() => {
    client?.disconnect();
    client = undefined;
  });

  it('falls back in process without waiting for the reconnect backoff', async () => {
    client = createRateLimitRedisClient(UNREACHABLE_REDIS_URL);
    client.on('error', () => {
      // The connection keeps retrying in the background; the test only cares
      // that the request path does not wait for it.
    });

    const store = new RedisRateLimitStore(client, 'team-outage');
    store.init({ windowMs: 60_000 } as Options);

    const timings: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const started = Date.now();
      const result = await store.increment('owner-outage');
      timings.push(Date.now() - started);
      expect(result.totalHits).toBe(attempt);
    }

    // Six local hits reach the accept limiter's cap, so express-rate-limit
    // returns 429 even though Redis never answered. The cap itself is covered
    // by the shared store cases; this test guards the fast fallback.
    expect(timings.every((elapsed) => elapsed < 1_000)).toBe(true);
  });

  it('gives up on a connected Redis that accepts commands but never replies', async () => {
    // A socket that stays open looks healthy to the client, so a missing
    // command timeout would hang every invitation request instead of failing
    // open. Answer the handshake so the client reaches ready, then let the
    // rate limit command sit unanswered.
    const silent = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (!text.includes('EVAL') && /CLIENT|SETINFO|SETNAME/i.test(text)) {
          socket.write('+OK\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;

    client = createRateLimitRedisClient(`redis://127.0.0.1:${port}`);
    client.on('error', () => {
      // The client may drop and retry once the command times out; the request
      // path must not wait on that reconnect.
    });
    await new Promise<void>((resolve) => client!.once('ready', resolve));

    const store = new RedisRateLimitStore(client, 'team-silent');
    store.init({ windowMs: 60_000 } as Options);

    const started = Date.now();
    const result = await store.increment('owner-silent');
    const elapsed = Date.now() - started;

    expect(result.totalHits).toBe(1);
    // Without the command timeout this call would never settle; the lower bound
    // also proves it waited for the timeout rather than skipping Redis at once.
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(1_500);

    client.disconnect();
    client = undefined;
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });
});
