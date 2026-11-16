import { describe, it, expect, vi, beforeEach, type Mocked } from 'vitest';
import { AuthService } from './auth.service.js';
import { IAuthRepository } from '../../domain/repositories/auth.repository.js';
import { User } from '../../domain/entities/user.entity.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { DuplicateEmailError, UnauthorizedError } from '../../domain/errors.js';

vi.mock('bcrypt');
vi.mock('jsonwebtoken');

describe('AuthService', () => {
  let authService: AuthService;
  let mockAuthRepository: Mocked<IAuthRepository>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAuthRepository = {
      findUserByEmail: vi.fn(),
      createUser: vi.fn(),
      createBusiness: vi.fn(),
      findUserById: vi.fn(),
      updateUser: vi.fn(),
      createBusinessMember: vi.fn(),
      findBusinessMember: vi.fn(),
      findUserBusinesses: vi.fn(),
      createRefreshToken: vi.fn(),
      findRefreshToken: vi.fn(),
      revokeRefreshToken: vi.fn(),
    } as unknown as Mocked<IAuthRepository>;

    authService = new AuthService(mockAuthRepository);
  });

  describe('register', () => {
    it('throws error if email already exists', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce({ id: '123' } as User);

      await expect(
        authService.register('test@test.com', 'pass', 'Test User', 'Test Biz'),
      ).rejects.toThrow(DuplicateEmailError);
    });

    it('creates user, business, member, and tokens successfully', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce(null);
      vi.mocked(bcrypt.genSalt).mockResolvedValueOnce('salt' as never);
      vi.mocked(bcrypt.hash).mockResolvedValueOnce('hashed_pass' as never);

      mockAuthRepository.createUser.mockResolvedValueOnce({ id: 'user1' } as User);
      mockAuthRepository.createBusiness.mockResolvedValueOnce({ _id: 'biz1', name: 'Test Biz' });
      mockAuthRepository.createBusinessMember.mockResolvedValueOnce(undefined);
      mockAuthRepository.createRefreshToken.mockResolvedValueOnce(undefined);
      mockAuthRepository.findUserBusinesses.mockResolvedValueOnce([
        { businessId: { _id: 'biz1' }, role: 'OWNER', status: 'ACTIVE' },
      ]);
      vi.mocked(jwt.sign).mockReturnValue('access_token' as unknown as void);

      const result = await authService.register(
        '  Test@TEST.com  ',
        'pass',
        'Test User',
        'Test Biz',
      );

      expect(mockAuthRepository.findUserByEmail).toHaveBeenCalledWith('test@test.com');
      expect(mockAuthRepository.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'test@test.com' }),
      );
      expect(mockAuthRepository.createBusiness).toHaveBeenCalledWith('Test Biz');
      expect(mockAuthRepository.createBusinessMember).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'OWNER' }),
      );
      expect(result.accessToken).toBe('access_token');
      expect(result.refreshToken).toBeDefined();
    });

    it('turns a duplicate lower email unique violation into a conflict', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce(null);
      vi.mocked(bcrypt.genSalt).mockResolvedValueOnce('salt' as never);
      vi.mocked(bcrypt.hash).mockResolvedValueOnce('hashed_pass' as never);
      const violation = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
      mockAuthRepository.createUser.mockRejectedValueOnce(violation);

      await expect(
        authService.register('dup@example.com', 'pass', 'Dup User', 'Dup Biz'),
      ).rejects.toThrow(DuplicateEmailError);
    });
  });

  describe('login', () => {
    it('normalizes the email before lookup', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce(null);
      await expect(authService.login('  Test@TEST.com  ', 'pass')).rejects.toThrow(
        UnauthorizedError,
      );
      expect(mockAuthRepository.findUserByEmail).toHaveBeenCalledWith('test@test.com');
    });

    it('throws error for invalid password', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce({
        id: '123',
        passwordHash: 'hash',
      } as User);
      vi.mocked(bcrypt.compare).mockResolvedValueOnce(false as never);

      await expect(authService.login('test@test.com', 'wrong')).rejects.toThrow(UnauthorizedError);
    });

    it('returns tokens on successful login', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce({
        id: '123',
        passwordHash: 'hash',
      } as User);
      vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);
      mockAuthRepository.findUserBusinesses.mockResolvedValueOnce([
        { businessId: 'biz1', role: 'OWNER', status: 'ACTIVE' },
      ]);
      mockAuthRepository.createRefreshToken.mockResolvedValueOnce(undefined);
      vi.mocked(jwt.sign).mockReturnValue('access_token' as unknown as void);

      const result = await authService.login('test@test.com', 'pass');

      expect(result.accessToken).toBe('access_token');
      expect(result.refreshToken).toBeDefined();
    });
  });

  describe('issueTokensForUser', () => {
    it('puts the preferred business first and keeps the other memberships in order', async () => {
      mockAuthRepository.findUserBusinesses.mockResolvedValueOnce([
        { businessId: 'biz-a', role: 'STAFF', status: 'ACTIVE' },
        { businessId: 'biz-b', role: 'OWNER', status: 'ACTIVE' },
        { businessId: 'biz-c', role: 'STAFF', status: 'ACTIVE' },
      ]);
      mockAuthRepository.createRefreshToken.mockResolvedValueOnce(undefined);
      vi.mocked(jwt.sign).mockReturnValue('access_token' as unknown as void);

      await authService.issueTokensForUser('user-1', 'biz-b');

      const payload = vi.mocked(jwt.sign).mock.calls[0][0] as {
        memberships: { businessId: string }[];
      };
      expect(payload.memberships.map((membership) => membership.businessId)).toEqual([
        'biz-b',
        'biz-a',
        'biz-c',
      ]);
    });
  });

  describe('oauthLogin', () => {
    it('links account if user exists', async () => {
      const user = { id: '123', oauth: [] } as unknown as User;
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce(user);
      mockAuthRepository.updateUser.mockResolvedValueOnce(undefined);
      mockAuthRepository.findUserBusinesses.mockResolvedValueOnce([]);
      vi.mocked(jwt.sign).mockReturnValue('access_token' as unknown as void);

      await authService.oauthLogin('t@t.com', 'N', 'google', 'g123');

      expect(mockAuthRepository.updateUser).toHaveBeenCalledWith('123', {
        oauth: [{ provider: 'google', providerId: 'g123' }],
      });
    });

    it('creates user and business if new', async () => {
      mockAuthRepository.findUserByEmail.mockResolvedValueOnce(null);
      mockAuthRepository.createUser.mockResolvedValueOnce({ id: 'user1' } as User);
      mockAuthRepository.createBusiness.mockResolvedValueOnce({ _id: 'biz1', name: 'N Business' });
      mockAuthRepository.createBusinessMember.mockResolvedValueOnce(undefined);
      mockAuthRepository.findUserBusinesses.mockResolvedValueOnce([]);
      vi.mocked(jwt.sign).mockReturnValue('access_token' as unknown as void);

      await authService.oauthLogin('t@t.com', 'N', 'google', 'g123');

      expect(mockAuthRepository.createUser).toHaveBeenCalled();
      expect(mockAuthRepository.createBusiness).toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('throws if token not found', async () => {
      mockAuthRepository.findRefreshToken.mockResolvedValueOnce(null);
      await expect(authService.refresh('token')).rejects.toThrow(UnauthorizedError);
    });

    it('throws and revokes if token is expired', async () => {
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1);
      mockAuthRepository.findRefreshToken.mockResolvedValueOnce({
        revoked: false,
        expiresAt: expiredDate,
      });

      await expect(authService.refresh('token')).rejects.toThrow(UnauthorizedError);
      expect(mockAuthRepository.revokeRefreshToken).toHaveBeenCalledWith('token');
    });

    it('issues new tokens on success', async () => {
      const validDate = new Date();
      validDate.setDate(validDate.getDate() + 1);
      mockAuthRepository.findRefreshToken.mockResolvedValueOnce({
        userId: 'u1',
        revoked: false,
        expiresAt: validDate,
      });
      mockAuthRepository.findUserById.mockResolvedValueOnce({ id: 'u1', isActive: true } as User);
      mockAuthRepository.revokeRefreshToken.mockResolvedValueOnce(undefined);
      mockAuthRepository.findUserBusinesses.mockResolvedValueOnce([]);
      vi.mocked(jwt.sign).mockReturnValue('access_token' as unknown as void);

      const result = await authService.refresh('token');

      expect(mockAuthRepository.revokeRefreshToken).toHaveBeenCalledWith('token');
      expect(result.accessToken).toBe('access_token');
    });

    // covers AC-17: the refresh handler rebuilds the claim list through the
    // ACTIVE filter, so a removed membership never reappears in a token.
    it('rebuilds tokens with only ACTIVE memberships', async () => {
      const validDate = new Date();
      validDate.setDate(validDate.getDate() + 1);
      mockAuthRepository.findRefreshToken.mockResolvedValueOnce({
        userId: 'u1',
        revoked: false,
        expiresAt: validDate,
      });
      mockAuthRepository.findUserById.mockResolvedValueOnce({ id: 'u1', isActive: true } as User);
      mockAuthRepository.revokeRefreshToken.mockResolvedValueOnce(undefined);
      mockAuthRepository.findUserBusinesses.mockResolvedValueOnce([
        { businessId: 'biz1', role: 'OWNER', status: 'ACTIVE' },
        { businessId: 'biz2', role: 'STAFF', status: 'REMOVED' },
      ]);
      vi.mocked(jwt.sign).mockReturnValue('access_token' as unknown as void);

      await authService.refresh('token');

      expect(jwt.sign).toHaveBeenCalledWith(
        { userId: 'u1', memberships: [{ businessId: 'biz1', role: 'OWNER' }] },
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('logout', () => {
    it('revokes token', async () => {
      mockAuthRepository.revokeRefreshToken.mockResolvedValueOnce(undefined);
      await authService.logout('token');
      expect(mockAuthRepository.revokeRefreshToken).toHaveBeenCalledWith('token');
    });
  });

  describe('getProfile', () => {
    it('returns the user and only active businesses', async () => {
      mockAuthRepository.findUserById.mockResolvedValueOnce({
        id: 'u1',
        email: 'e',
        name: 'n',
        isActive: true,
      } as User);
      mockAuthRepository.findUserBusinesses.mockResolvedValueOnce([
        { businessId: 'b1', status: 'ACTIVE' },
        { businessId: 'b2', status: 'REMOVED' },
      ]);

      const result = await authService.getProfile('u1');

      expect(result.user).toEqual({ id: 'u1', email: 'e', name: 'n', isActive: true });
      expect(result.businesses).toHaveLength(1);
    });
  });
});
