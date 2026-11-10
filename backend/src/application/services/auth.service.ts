import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { IAuthRepository } from '../../domain/repositories/auth.repository.js';
import { config } from '../../infrastructure/config.js';
import { User } from '../../domain/entities/user.entity.js';
import { DuplicateEmailError, UnauthorizedError, NotFoundError } from '../../domain/errors.js';
import { isUniqueViolation } from './database-errors.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AuthService {
  constructor(private readonly authRepository: IAuthRepository) {}

  async register(
    email: string,
    password: string,
    name: string,
    businessName: string,
  ): Promise<AuthTokens> {
    email = normaliseEmail(email);
    const existingUser = await this.authRepository.findUserByEmail(email);
    if (existingUser) {
      throw new DuplicateEmailError('Email already exists');
    }

    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    let user: User;
    try {
      user = await this.authRepository.createUser({
        email,
        passwordHash: hashed,
        name,
        oauth: [],
        isActive: true,
      });
    } catch (error) {
      // Two registrations for the same address, in different letter cases, can
      // both pass the check above and collide on the lower email unique index.
      // The loser answers 409, not an opaque 500.
      if (isUniqueViolation(error)) throw new DuplicateEmailError('Email already exists');
      throw error;
    }

    const business = await this.authRepository.createBusiness(businessName);

    await this.authRepository.createBusinessMember({
      businessId: business._id,
      userId: user.id,
      role: 'OWNER',
      status: 'ACTIVE',
    });

    return this.generateTokens(user.id, [{ businessId: business._id, role: 'OWNER' }]);
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const user = await this.authRepository.findUserByEmail(normaliseEmail(email));
    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    return this.createTokensForUser(user);
  }

  async oauthLogin(
    email: string,
    name: string,
    provider: string,
    providerId: string,
  ): Promise<AuthTokens> {
    email = normaliseEmail(email);
    let user = await this.authRepository.findUserByEmail(email);

    if (user) {
      const providerExists = user.oauth?.some(
        (o) => o.provider === provider && o.providerId === providerId,
      );
      if (!providerExists) {
        const updatedOauth = [...(user.oauth || []), { provider, providerId }];
        await this.authRepository.updateUser(user.id, { oauth: updatedOauth });
        user.oauth = updatedOauth;
      }
    } else {
      try {
        user = await this.authRepository.createUser({
          email,
          name,
          oauth: [{ provider, providerId }],
          isActive: true,
        });
      } catch (error) {
        // The same address can race two first time OAuth logins; the loser sees
        // the existing account conflict instead of a 500.
        if (isUniqueViolation(error)) throw new DuplicateEmailError('Email already exists');
        throw error;
      }

      const business = await this.authRepository.createBusiness(`${name}'s Business`);

      await this.authRepository.createBusinessMember({
        businessId: business._id,
        userId: user.id,
        role: 'OWNER',
        status: 'ACTIVE',
      });
    }

    return this.createTokensForUser(user);
  }

  /**
   * Tokens carry active memberships only. A removed member keeps a valid login
   * but no business claim, and a refresh rebuilds the claim list from the
   * database, so a stale access token never outlives the membership behind it.
   */
  private async createTokensForUser(user: User): Promise<AuthTokens> {
    const memberships = await this.activeMemberships(user.id);
    return this.generateTokens(user.id, memberships);
  }

  private async activeMemberships(
    userId: string,
  ): Promise<{ businessId: string; role: 'OWNER' | 'STAFF' }[]> {
    const members = (await this.authRepository.findUserBusinesses(userId)) as {
      businessId: string | { _id: string };
      role: string;
      status?: string;
    }[];

    return members
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({
        businessId: (m.businessId as Record<string, unknown>)._id
          ? String((m.businessId as Record<string, unknown>)._id)
          : String(m.businessId),
        role: m.role === 'OWNER' ? 'OWNER' : 'STAFF',
      }));
  }

  /**
   * Tokens for a member who just accepted an invitation. That business is put
   * first so the client lands in it even when the account already belonged to
   * another one.
   */
  async issueTokensForUser(userId: string, preferredBusinessId: string): Promise<AuthTokens> {
    const memberships = await this.activeMemberships(userId);
    // Put the just accepted business first and keep the remaining order as the
    // database returned it, instead of relying on a non total sort comparator.
    const preferred = memberships.filter((m) => m.businessId === preferredBusinessId);
    const rest = memberships.filter((m) => m.businessId !== preferredBusinessId);
    return this.generateTokens(userId, [...preferred, ...rest]);
  }

  private async generateTokens(
    userId: string,
    memberships: { businessId: string; role: string }[],
  ): Promise<AuthTokens> {
    const accessToken = jwt.sign({ userId, memberships }, config.JWT_SECRET, { expiresIn: '15m' });

    const refreshTokenValue = randomBytes(40).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.authRepository.createRefreshToken(userId, refreshTokenValue, expiresAt);

    return { accessToken, refreshToken: refreshTokenValue };
  }

  async refresh(token: string): Promise<AuthTokens> {
    const refreshTokenDoc = (await this.authRepository.findRefreshToken(token)) as {
      userId: string;
      revoked: boolean;
      expiresAt: Date;
    } | null;
    if (!refreshTokenDoc || refreshTokenDoc.revoked || refreshTokenDoc.expiresAt < new Date()) {
      if (refreshTokenDoc && !refreshTokenDoc.revoked) {
        await this.authRepository.revokeRefreshToken(token);
      }
      throw new UnauthorizedError('Invalid refresh token');
    }

    const user = await this.authRepository.findUserById(refreshTokenDoc.userId.toString());
    if (!user || !user.isActive) {
      throw new NotFoundError('User not found or inactive');
    }

    await this.authRepository.revokeRefreshToken(token);

    return this.createTokensForUser(user);
  }

  async logout(token: string): Promise<void> {
    await this.authRepository.revokeRefreshToken(token);
  }

  async getProfile(userId: string) {
    const user = await this.authRepository.findUserById(userId);
    if (!user) throw new NotFoundError('User not found');

    // Only active memberships reach the client, matching the token path. A
    // removed member keeps a valid login but must not see a business they can no
    // longer open, so a future consumer of `businesses` cannot leak one either.
    const memberships = (await this.authRepository.findUserBusinesses(userId)) as {
      businessId: string | { _id: string };
      role: string;
      status?: string;
    }[];
    const businesses = memberships.filter((membership) => membership.status === 'ACTIVE');

    return {
      user: { id: user.id, email: user.email, name: user.name, isActive: user.isActive },
      businesses,
    };
  }
}
