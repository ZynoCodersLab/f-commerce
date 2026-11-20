import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => undefined),
  changeRole: vi.fn(async () => ({
    id: 'member-1',
    userId: 'user-2',
    name: 'Sam Staff',
    email: 'sam@example.com',
    role: 'OWNER' as const,
    joinedAt: '2026-01-05T09:00:00.000Z',
  })),
  removeMember: vi.fn(async () => undefined),
  invite: vi.fn(async () => ({
    invitation: {
      id: 'inv-1',
      email: 'new@example.com',
      role: 'STAFF' as const,
      invitedByName: 'Maya Owner',
      sentAt: null,
      lastSentAt: '2026-01-05T09:00:00.000Z',
      createdAt: '2026-01-05T09:00:00.000Z',
      expiresAt: '2026-01-12T09:00:00.000Z',
      status: 'PENDING' as const,
      emailStatus: 'QUEUED' as const,
      emailError: null,
    },
    inviteUrl: 'https://shop.example.com/invite/tok',
    emailStatus: 'QUEUED' as const,
    emailError: null,
  })),
}));

vi.mock('../../infrastructure/config.js', () => ({
  config: {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret',
    APP_ORIGIN: 'http://localhost:3000',
    REDIS_URL: 'redis://127.0.0.1:6379',
    RATE_LIMIT_DISABLED: false,
  },
}));

vi.mock('../../infrastructure/database/drizzle/context.js', () => ({
  requestContext: {
    getStore: () => ({ businessId: 'biz-1', userId: 'owner-1' }),
  },
}));

vi.mock('../middlewares/auth.middleware.js', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    const userId = req.header('x-user-id') ?? 'owner-1';
    const role = (req.header('x-role') ?? 'OWNER') as 'OWNER' | 'STAFF';
    req.user = { userId, memberships: [{ businessId: 'biz-1', role }] };
    next();
  },
  requireBusinessRole: (roles: ('OWNER' | 'STAFF')[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
      const role = req.user?.memberships[0]?.role;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }
      next();
    };
  },
}));

// Keep this route wiring test independent of external Redis state; live Redis
// cross-instance behavior is covered in invite-rate-limit.redis.test.ts.
vi.mock('../middlewares/redis-rate-limit-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middlewares/redis-rate-limit-store.js')>();
  return {
    ...actual,
    getRateLimitRedisClient: () => ({
      eval: () => Promise.reject(new Error('offline for route unit test')),
    }),
  };
});

vi.mock('../../application/services/team.service.js', () => ({
  TeamService: vi.fn(function TeamService() {
    return {
      cancel: mocks.cancel,
      changeRole: mocks.changeRole,
      removeMember: mocks.removeMember,
      invite: mocks.invite,
    };
  }),
}));

vi.mock('../../application/services/auth.service.js', () => ({
  AuthService: vi.fn(function AuthService() {
    return {};
  }),
}));

vi.mock('../../infrastructure/database/drizzle/repositories/team.repository.js', () => ({
  DrizzleTeamRepository: vi.fn(function DrizzleTeamRepository() {
    return {};
  }),
}));

vi.mock('../../infrastructure/database/drizzle/repositories/auth.repository.js', () => ({
  DrizzleAuthRepository: vi.fn(function DrizzleAuthRepository() {
    return {};
  }),
}));

vi.mock('../../infrastructure/queue/invite-queue.js', () => ({
  enqueueInviteEmail: vi.fn(async () => true),
}));

vi.mock('../../infrastructure/services/resend-email.service.js', () => ({
  isEmailConfigured: () => false,
}));

import { teamRouter } from './team.controller.js';
import { closeRateLimitStore } from '../middlewares/redis-rate-limit-store.js';

const app = express();
app.use(express.json());
app.use('/api/team', teamRouter);

describe('team mutation rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeRateLimitStore();
  });

  it('caps cancel, role change, and member removal at 30 per 15 minutes per owner without burning invite quota', async () => {
    const owner = 'owner-mutation-cap';

    for (let i = 0; i < 10; i += 1) {
      const cancelled = await request(app)
        .delete(`/api/team/invitations/inv-${i}`)
        .set('x-user-id', owner);
      expect(cancelled.status).toBe(200);

      const updated = await request(app)
        .patch(`/api/team/members/member-${i}`)
        .set('x-user-id', owner)
        .send({ role: 'OWNER' });
      expect(updated.status).toBe(200);

      const removed = await request(app)
        .delete(`/api/team/members/member-${i}`)
        .set('x-user-id', owner);
      expect(removed.status).toBe(200);
    }

    // All three mutation endpoints share the same 30-request owner bucket.
    const blockedCancel = await request(app)
      .delete('/api/team/invitations/inv-over')
      .set('x-user-id', owner);
    expect(blockedCancel.status).toBe(429);
    expect(blockedCancel.body.error).toBe('RATE_LIMITED');
    expect(blockedCancel.headers['referrer-policy']).toBe('no-referrer');
    expect(blockedCancel.headers['cache-control']).toBe('no-store');
    expect(blockedCancel.headers['x-robots-tag']).toBe('noindex');
    expect(blockedCancel.headers['ratelimit']).toBeDefined();
    expect(blockedCancel.headers['retry-after']).toBeDefined();
    expect(blockedCancel.headers['x-ratelimit-limit']).toBeUndefined();

    const blockedRole = await request(app)
      .patch('/api/team/members/member-over')
      .set('x-user-id', owner)
      .send({ role: 'STAFF' });
    expect(blockedRole.status).toBe(429);
    expect(blockedRole.body.error).toBe('RATE_LIMITED');

    const blockedRemove = await request(app)
      .delete('/api/team/members/member-over')
      .set('x-user-id', owner);
    expect(blockedRemove.status).toBe(429);
    expect(blockedRemove.body.error).toBe('RATE_LIMITED');

    // Another owner has a separate counter.
    const otherOwner = await request(app)
      .patch('/api/team/members/member-1')
      .set('x-user-id', 'owner-other')
      .send({ role: 'STAFF' });
    expect(otherOwner.status).toBe(200);

    // The capped owner's invite email quota stays untouched.
    const inviteRes = await request(app)
      .post('/api/team/invitations')
      .set('x-user-id', owner)
      .send({ email: 'new@example.com' });
    expect(inviteRes.status).toBe(201);
  });

  it('rejects a STAFF caller with 403 before running the mutation rate limiter', async () => {
    for (let i = 0; i < 35; i += 1) {
      const res = await request(app)
        .delete('/api/team/members/member-1')
        .set('x-user-id', 'staff-user')
        .set('x-role', 'STAFF');
      expect(res.status).toBe(403);
    }
  });
});
