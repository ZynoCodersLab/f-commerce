import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireAuth, requireBusinessRole } from './auth.middleware.js';
import jwt from 'jsonwebtoken';
import { runWithContext } from '../../infrastructure/database/drizzle/context.js';
import { DrizzleAuthRepository } from '../../infrastructure/database/drizzle/repositories/auth.repository.js';
import { Request, Response, NextFunction } from 'express';

vi.mock('jsonwebtoken');
vi.mock('../../infrastructure/database/drizzle/repositories/auth.repository.js');
vi.mock('../../infrastructure/database/drizzle/context.js');

describe('Auth Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = { headers: {} };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    next = vi.fn();
    vi.clearAllMocks();
  });

  describe('requireAuth', () => {
    it('returns 401 if no auth header', () => {
      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing or invalid authorization header',
        message: 'Missing or invalid authorization header',
      });
    });

    it('returns 401 if token is invalid', () => {
      req.headers!.authorization = 'Bearer invalid';
      vi.mocked(jwt.verify).mockImplementation(() => {
        throw new Error();
      });

      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid or expired token',
        message: 'Invalid or expired token',
      });
    });

    it('calls next and sets user if token is valid', () => {
      req.headers!.authorization = 'Bearer valid';
      vi.mocked(jwt.verify).mockReturnValue({ userId: '123' } as never);

      requireAuth(req as Request, res as Response, next);
      expect(req.user).toEqual({ userId: '123' });
      expect(next).toHaveBeenCalled();
    });

    it('returns 401 when the token has no user id', () => {
      req.headers!.authorization = 'Bearer valid';
      vi.mocked(jwt.verify).mockReturnValue({ memberships: [] } as never);

      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when the token user id is blank', () => {
      req.headers!.authorization = 'Bearer valid';
      vi.mocked(jwt.verify).mockReturnValue({ userId: '   ', memberships: [] } as never);

      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireBusinessRole', () => {
    const findMember = vi.fn();

    beforeEach(() => {
      findMember.mockReset();
    });

    // A typed class mock: the middleware builds its repository with new, so the
    // constructor must be a regular function, and it is set after the shared
    // clearAllMocks so the implementation survives every test.
    function installRepository(): void {
      vi.mocked(DrizzleAuthRepository).mockImplementation(function (this: {
        findBusinessMember: typeof findMember;
      }) {
        this.findBusinessMember = findMember;
      } as never);
    }

    it('returns 400 if no x-business-id header', async () => {
      installRepository();
      const middleware = requireBusinessRole(['OWNER']);
      await middleware(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing x-business-id header',
        message: 'Missing x-business-id header',
      });
    });

    it('returns 401 if no user attached by requireAuth', async () => {
      installRepository();
      req.headers!['x-business-id'] = 'biz1';
      req.user = undefined;

      const middleware = requireBusinessRole(['OWNER']);
      await middleware(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Authentication required',
        message: 'Authentication required',
      });
    });

    // covers AC-17: access follows the stored membership, not the token claim
    it('returns 403 when the database has no active membership for the business', async () => {
      installRepository();
      req.headers!['x-business-id'] = 'biz1';
      req.user = { userId: '123', memberships: [{ businessId: 'biz1', role: 'OWNER' }] };
      findMember.mockResolvedValueOnce(null);

      const middleware = requireBusinessRole(['OWNER']);
      await middleware(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'BUSINESS_ACCESS_DENIED',
        message: 'You do not have access to this business',
      });
      expect(next).not.toHaveBeenCalled();
    });

    // covers AC-15: a removed member is refused on the very next request
    it('returns 403 when the membership was removed', async () => {
      installRepository();
      req.headers!['x-business-id'] = 'biz1';
      req.user = { userId: '123', memberships: [{ businessId: 'biz1', role: 'OWNER' }] };
      findMember.mockResolvedValueOnce({ role: 'OWNER', status: 'REMOVED' });

      const middleware = requireBusinessRole(['OWNER']);
      await middleware(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'BUSINESS_ACCESS_DENIED',
        message: 'You do not have access to this business',
      });
    });

    // covers AC-14: a token issued while the member was an owner does not keep the owner role
    it('uses the stored role so a demotion takes effect at once', async () => {
      installRepository();
      req.headers!['x-business-id'] = 'biz1';
      req.user = { userId: '123', memberships: [{ businessId: 'biz1', role: 'OWNER' }] };
      findMember.mockResolvedValueOnce({ role: 'STAFF', status: 'ACTIVE' });

      const middleware = requireBusinessRole(['OWNER']);
      await middleware(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Insufficient permissions',
        message: 'You do not have permission to perform this action',
      });
    });

    it('allows STAFF user when role is allowed', async () => {
      installRepository();
      req.headers!['x-business-id'] = 'biz1';
      req.user = { userId: '123', memberships: [{ businessId: 'biz1', role: 'OWNER' }] };
      findMember.mockResolvedValueOnce({ role: 'STAFF', status: 'ACTIVE' });

      const middleware = requireBusinessRole(['OWNER', 'STAFF']);
      await middleware(req as Request, res as Response, next);

      expect(runWithContext).toHaveBeenCalledWith(
        { userId: '123', businessId: 'biz1', role: 'STAFF' },
        expect.any(Function),
      );
      const callback = vi.mocked(runWithContext).mock.calls[0][1];
      callback();
      expect(next).toHaveBeenCalled();
    });

    it('sets context and calls next on success', async () => {
      installRepository();
      req.headers!['x-business-id'] = 'biz1';
      req.user = { userId: '123', memberships: [{ businessId: 'biz1', role: 'OWNER' }] };
      findMember.mockResolvedValueOnce({ role: 'OWNER', status: 'ACTIVE' });

      const middleware = requireBusinessRole(['OWNER']);
      await middleware(req as Request, res as Response, next);

      expect(runWithContext).toHaveBeenCalledWith(
        { userId: '123', businessId: 'biz1', role: 'OWNER' },
        expect.any(Function),
      );

      const callback = vi.mocked(runWithContext).mock.calls[0][1];
      callback();
      expect(next).toHaveBeenCalled();
    });

    // a database failure is a server problem, never a silent permission denial
    it('passes a database failure to the error handler', async () => {
      installRepository();
      req.headers!['x-business-id'] = 'biz1';
      req.user = { userId: '123', memberships: [{ businessId: 'biz1', role: 'OWNER' }] };
      const failure = new Error('connection lost');
      findMember.mockRejectedValueOnce(failure);

      const middleware = requireBusinessRole(['OWNER']);
      await middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith(failure);
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
