import type { Store, Options, IncrementResponse } from 'express-rate-limit';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A rate limit counter kept in this process.
 *
 * The team limiters fall back to this whenever Redis cannot answer, which is
 * the fail open rule from the spec: a busy or missing Redis slows nobody down,
 * but each instance still refuses obvious floods. Limits shared across
 * instances (invite bursts from many servers) need a shared store; this one is
 * the safety net, not the primary guard.
 */
export class MemoryFallbackStore implements Store {
  private readonly buckets = new Map<string, Bucket>();
  private windowMs = 60_000;

  init(options: Options): void {
    const windowMs = Number(options.windowMs);
    // A single limiter owns this store, so the window never changes. Ignoring
    // anything else keeps a stray call from widening every bucket.
    if (Number.isFinite(windowMs) && windowMs > 0) this.windowMs = windowMs;
  }

  increment(rawKey: string): IncrementResponse {
    // A key can arrive as a number, and the map must not merge 1 and '1'.
    const key = String(rawKey);
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + this.windowMs };
      this.buckets.set(key, fresh);
      this.sweep(now);
      return { totalHits: fresh.count, resetTime: new Date(fresh.resetAt) };
    }

    bucket.count += 1;
    return { totalHits: bucket.count, resetTime: new Date(bucket.resetAt) };
  }

  decrement(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.count > 0) bucket.count -= 1;
  }

  resetKey(key: string): void {
    this.buckets.delete(key);
  }

  resetAll(): void {
    this.buckets.clear();
  }

  init0(): void {
    // Nothing to schedule; expired buckets are dropped on the next increment.
  }

  private sweep(now: number): void {
    if (this.buckets.size < 1_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
