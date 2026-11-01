import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { authRouter } from './auth.controller.js';
import { AuthService } from '../../application/services/auth.service.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { DuplicateEmailError, UnauthorizedError } from '../../domain/errors.js';

vi.mock('../../application/services/auth.service.js');
vi.mock('../middlewares/auth.middleware.js', () => ({
  requireAuth: vi.fn((req, res, next) => {
    req.user = { userId: '123', memberships: [] };
    next();
  }),
  requireBusinessRole: vi.fn(
    () =>
      (
        _req: import('express').Request,
        _res: import('express').Response,
        next: import('express').NextFunction,
      ) =>
        next(),
  ),
}));

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRouter);

describe('Auth Controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/auth/register', () => {
    it('returns 201 on success', async () => {
      vi.mocked(AuthService.prototype.register).mockResolvedValueOnce({
        accessToken: 'access',
        refreshToken: 'refresh',
      });

      const res = await request(app).post('/api/auth/register').send({
        email: 'test@test.com',
        password: 'password123',
        name: 'Test User',
        businessName: 'Test Business',
      });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ accessToken: 'access', businessId: undefined });
      expect(res.header['set-cookie'][0]).toContain('refreshToken=refresh');
    });

    it('returns 201 with businessId extracted from token', async () => {
      // Create a valid JWT payload with businessId: biz-1
      const payload = Buffer.from(
        JSON.stringify({ memberships: [{ businessId: 'biz-1' }] }),
      ).toString('base64');
      const fullToken = `access.${payload}.signature`;
      vi.mocked(AuthService.prototype.register).mockResolvedValueOnce({
        accessToken: fullToken,
        refreshToken: 'refresh',
      });

      const res = await request(app).post('/api/auth/register').send({
        email: 'test@test.com',
        password: 'password123',
        name: 'Test User',
        businessName: 'Test Business',
      });

      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBe(fullToken);
      expect(res.body.businessId).toBe('biz-1');
      expect(res.header['set-cookie'][0]).toContain('refreshToken=refresh');
    });

    it('handles malformed JWT token gracefully', async () => {
      vi.mocked(AuthService.prototype.register).mockResolvedValueOnce({
        accessToken: 'access.invalid_base64_payload.signature',
        refreshToken: 'refresh',
      });

      const res = await request(app).post('/api/auth/register').send({
        email: 'test@test.com',
        password: 'password123',
        name: 'Test User',
        businessName: 'Test Business',
      });

      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBe('access.invalid_base64_payload.signature');
      expect(res.body.businessId).toBeUndefined();
    });

    it('returns 409 if email exists', async () => {
      vi.mocked(AuthService.prototype.register).mockRejectedValueOnce(
        new DuplicateEmailError('Email already exists'),
      );

      const res = await request(app).post('/api/auth/register').send({
        email: 'test@test.com',
        password: 'password123',
        name: 'Test User',
        businessName: 'Test Business',
      });

      expect(res.status).toBe(409);
    });

    it('returns 400 for invalid email format', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'invalid-email',
        password: 'password123',
        name: 'Test',
        businessName: 'Test Business',
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for password shorter than 8 characters', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'test@test.com',
        password: 'short',
        name: 'Test',
        businessName: 'Test Business',
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'test@test.com', password: 'password123' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns 200 on success with businessId extracted from token', async () => {
      // Create a valid JWT payload with businessId: biz-1
      const payload = Buffer.from(
        JSON.stringify({ memberships: [{ businessId: 'biz-1' }] }),
      ).toString('base64');
      const fullToken = `access.${payload}.signature`;
      vi.mocked(AuthService.prototype.login).mockResolvedValueOnce({
        accessToken: fullToken,
        refreshToken: 'refresh',
      });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 't@t.com', password: 'p' });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBe(fullToken);
      expect(res.body.businessId).toBe('biz-1');
    });

    it('returns 401 on invalid credentials', async () => {
      vi.mocked(AuthService.prototype.login).mockRejectedValueOnce(
        new UnauthorizedError('Invalid credentials'),
      );

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 't@t.com', password: 'wrong' });

      expect(res.status).toBe(401);
    });

    it('returns 400 for invalid email format', async () => {
      const res = await request(app).post('/api/auth/login').send({
        email: 'not-an-email',
        password: 'password123',
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing password', async () => {
      const res = await request(app).post('/api/auth/login').send({
        email: 'test@test.com',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/oauth/:provider', () => {
    it('returns 200 on OAuth success with businessId extracted from token', async () => {
      // Create a valid JWT payload with businessId: biz-1
      const payload = Buffer.from(
        JSON.stringify({ memberships: [{ businessId: 'biz-1' }] }),
      ).toString('base64');
      const fullToken = `oauth_access.${payload}.signature`;
      vi.mocked(AuthService.prototype.oauthLogin).mockResolvedValueOnce({
        accessToken: fullToken,
        refreshToken: 'oauth_refresh',
      });

      const res = await request(app)
        .post('/api/auth/oauth/google')
        .send({ email: 't@google.com', name: 'Test', providerId: 'google123' });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBe(fullToken);
      expect(res.body.businessId).toBe('biz-1');
      expect(res.header['set-cookie'][0]).toContain('refreshToken=oauth_refresh');
    });

    it('returns 401 on OAuth failure', async () => {
      vi.mocked(AuthService.prototype.oauthLogin).mockRejectedValueOnce(
        new UnauthorizedError('OAuth fail'),
      );

      const res = await request(app)
        .post('/api/auth/oauth/google')
        .send({ email: 't@google.com', name: 'Test', providerId: 'google123' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('returns 200 with new access token', async () => {
      vi.mocked(AuthService.prototype.refresh).mockResolvedValueOnce({
        accessToken: 'new_access',
        refreshToken: 'new_refresh',
      });

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', 'refreshToken=old_refresh');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accessToken: 'new_access' });
      expect(res.header['set-cookie'][0]).toContain('refreshToken=new_refresh');
    });

    it('returns 400 when refresh token cookie is missing', async () => {
      const res = await request(app).post('/api/auth/refresh');

      expect(res.status).toBe(400);
    });

    it('returns 401 for invalid refresh token', async () => {
      vi.mocked(AuthService.prototype.refresh).mockRejectedValueOnce(
        new UnauthorizedError('Invalid refresh token'),
      );

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', 'refreshToken=invalid');

      expect(res.status).toBe(401);
    });

    it('returns 401 for expired or revoked refresh token', async () => {
      vi.mocked(AuthService.prototype.refresh).mockRejectedValueOnce(
        new UnauthorizedError('Token expired'),
      );

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', 'refreshToken=expired_token');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('returns 200 and revokes token', async () => {
      vi.mocked(AuthService.prototype.logout).mockResolvedValueOnce(undefined);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', 'refreshToken=some_token');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('returns 200 when no refresh token cookie present', async () => {
      const res = await request(app).post('/api/auth/logout');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      // AuthService.logout should not be called when no cookie
      expect(AuthService.prototype.logout).not.toHaveBeenCalled();
    });

    it('returns 500 when logout service fails', async () => {
      vi.mocked(AuthService.prototype.logout).mockRejectedValueOnce(new Error('Database error'));

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request(app)
          .post('/api/auth/logout')
          .set('Cookie', 'refreshToken=some_token');

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
          error: 'INTERNAL_ERROR',
          message: 'The server could not complete the request.',
        });
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns 200 and profile', async () => {
      vi.mocked(AuthService.prototype.getProfile).mockResolvedValueOnce({
        user: { id: '1', email: 'test@test.com', name: 'Test', isActive: true },
        businesses: [],
      });

      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({
        id: '1',
        email: 'test@test.com',
        name: 'Test',
        isActive: true,
      });
      expect(requireAuth).toHaveBeenCalled();
    });

    it('returns 401 when unauthorized via middleware', async () => {
      vi.mocked(requireAuth).mockImplementationOnce((_req, res) => {
        res.status(401).json({ error: 'Unauthorized' });
      });

      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(401);
    });

    it('returns 200 with profile data when authenticated', async () => {
      vi.mocked(AuthService.prototype.getProfile).mockResolvedValueOnce({
        user: { id: '1', email: 'test@test.com', name: 'Test', isActive: true },
        businesses: [{ businessId: 'biz-1', role: 'OWNER' }],
      });

      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe('1');
      expect(res.body.businesses).toHaveLength(1);
    });
  });
});
