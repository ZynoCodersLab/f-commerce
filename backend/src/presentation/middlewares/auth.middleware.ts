import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../infrastructure/config.js';
import { runWithContext } from '../../infrastructure/database/drizzle/context.js';
import { DrizzleAuthRepository } from '../../infrastructure/database/drizzle/repositories/auth.repository.js';
import { isUuid } from '../../domain/uuid.js';

interface JwtPayload {
  userId: string;
  memberships: { businessId: string; role: 'OWNER' | 'STAFF' }[];
}

/**
 * One repository for the process. It holds no per-request state, so the tenant
 * scope comes from the arguments and the request context, not the instance.
 */
let authRepository: DrizzleAuthRepository | null = null;

function getAuthRepository(): DrizzleAuthRepository {
  return (authRepository ??= new DrizzleAuthRepository());
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Missing or invalid authorization header',
      message: 'Missing or invalid authorization header',
    });
    return;
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    if (typeof decoded.userId !== 'string' || decoded.userId.trim() === '') {
      res
        .status(401)
        .json({ error: 'Invalid or expired token', message: 'Invalid or expired token' });
      return;
    }
    req.user = decoded;
    next();
  } catch {
    res
      .status(401)
      .json({ error: 'Invalid or expired token', message: 'Invalid or expired token' });
  }
}

/**
 * Gate every business route on the membership stored in the database right
 * now, not on the claims baked into a token that may be up to fifteen minutes
 * old. A removed member, or a member whose role was just demoted, is stopped on
 * the very next request. The token claim only decides which business the
 * request is about; the row decides whether it is allowed.
 */
export function requireBusinessRole(allowedRoles: ('OWNER' | 'STAFF')[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const businessId = req.headers['x-business-id'];

    if (typeof businessId !== 'string' || businessId === '') {
      res
        .status(400)
        .json({ error: 'Missing x-business-id header', message: 'Missing x-business-id header' });
      return;
    }

    // The header is compared against a uuid column, so a malformed value must
    // fail here instead of reaching Postgres as a 22P02 and returning a 500.
    if (!isUuid(businessId)) {
      res
        .status(400)
        .json({ error: 'Invalid x-business-id header', message: 'Invalid x-business-id header' });
      return;
    }

    const user = req.user;
    if (!user) {
      res
        .status(401)
        .json({ error: 'Authentication required', message: 'Authentication required' });
      return;
    }

    let role: 'OWNER' | 'STAFF' | undefined;
    try {
      const member = (await getAuthRepository().findBusinessMember(businessId, user.userId)) as {
        role?: string;
        status?: string;
      } | null;
      if (member?.status === 'ACTIVE') {
        role = member.role === 'OWNER' ? 'OWNER' : 'STAFF';
      }
    } catch (error) {
      // A database failure must not look like a permission decision, so it
      // becomes a plain server error instead of a silent 403.
      next(error);
      return;
    }

    if (!role) {
      res.status(403).json({
        error: 'BUSINESS_ACCESS_DENIED',
        message: 'You do not have access to this business',
      });
      return;
    }

    if (!allowedRoles.includes(role)) {
      res.status(403).json({
        error: 'Insufficient permissions',
        message: 'You do not have permission to perform this action',
      });
      return;
    }

    // Set the tenant context carried through AsyncLocalStorage
    runWithContext({ userId: user.userId, businessId, role }, () => {
      next();
    });
  };
}
