import { User } from '../entities/user.entity.js';

export interface IAuthRepository {
  findUserByEmail(email: string): Promise<User | null>;
  createUser(userData: Partial<User>): Promise<User>;
  createBusiness(name: string): Promise<{ _id: string; name: string }>;
  findUserById(userId: string): Promise<User | null>;
  updateUser(userId: string, data: Partial<User>): Promise<void>;
  createBusinessMember(data: {
    businessId: string;
    userId: string;
    role: 'OWNER' | 'STAFF';
    status: 'ACTIVE' | 'INVITED' | 'REMOVED';
  }): Promise<void>;
  findBusinessMember(businessId: string, userId: string): Promise<unknown | null>;
  findUserBusinesses(userId: string): Promise<unknown[]>;
  createRefreshToken(userId: string, token: string, expiresAt: Date): Promise<void>;
  findRefreshToken(token: string): Promise<unknown | null>;
  revokeRefreshToken(token: string): Promise<void>;
}
