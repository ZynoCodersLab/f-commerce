import { Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';
import {
  InviteAcceptSchema,
  InviteCreateSchema,
  MemberRoleUpdateSchema,
  TeamErrorCode,
} from '@f-commerce/contracts';
import { TeamService } from '../../application/services/team.service.js';
import { AuthService } from '../../application/services/auth.service.js';
import { requireAuth, requireBusinessRole } from '../middlewares/auth.middleware.js';
import {
  inviteAcceptRateLimiter,
  inviteAcceptTokenRateLimiter,
  invitePreviewRateLimiter,
  invitePreviewTokenRateLimiter,
  inviteWriteRateLimiter,
} from '../middlewares/invite-rate-limit.middleware.js';
import { DrizzleTeamRepository } from '../../infrastructure/database/drizzle/repositories/team.repository.js';
import { DrizzleAuthRepository } from '../../infrastructure/database/drizzle/repositories/auth.repository.js';
import { enqueueInviteEmail } from '../../infrastructure/queue/invite-queue.js';
import { isEmailConfigured } from '../../infrastructure/services/resend-email.service.js';
import { config } from '../../infrastructure/config.js';
import { requestContext } from '../../infrastructure/database/drizzle/context.js';
import { sendInternalError } from './internal-error.js';
import { setRefreshCookie } from './refresh-cookie.js';
import {
  ConflictError,
  DomainError,
  InviteAlreadyPendingError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  NotFoundError,
  ValidationError,
} from '../../domain/errors.js';

export const teamRouter = Router();
export const invitationRouter = Router();

const teamRepository = new DrizzleTeamRepository();
const authRepository = new DrizzleAuthRepository();
const teamService = new TeamService(
  teamRepository,
  authRepository,
  { enqueue: (data) => enqueueInviteEmail(data) },
  { isConfigured: isEmailConfigured },
  new AuthService(authRepository),
  config.APP_ORIGIN,
);

const ALLOWED_ROLES: ('OWNER' | 'STAFF')[] = ['OWNER', 'STAFF'];
const OWNER_ONLY: ('OWNER' | 'STAFF')[] = ['OWNER'];

/**
 * Anything that carries an invite link must not leak it through a referrer or
 * land in a cache or a search index (spec, security).
 */
function setLinkHeaders(res: Response): void {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
}

function actorFromContext(): { businessId: string; userId: string } {
  const context = requestContext.getStore();
  if (!context?.businessId || !context.userId) {
    throw new NotFoundError('No business context');
  }
  return { businessId: context.businessId, userId: context.userId };
}

function invalidFields(issues: { path: PropertyKey[] }[]): string[] {
  return Array.from(new Set(issues.map((issue) => String(issue.path[0] ?? '')))).filter(
    (field) => field !== '',
  );
}

/** One error shape for the whole team surface: a code, a message, and fields for validation. */
function sendError(res: Response, error: unknown): void {
  if (error instanceof ValidationError) {
    res.status(400).json({
      error: TeamErrorCode.VALIDATION_ERROR,
      message: error.message,
      fields: error.fields,
    });
    return;
  }
  if (error instanceof InviteAlreadyPendingError) {
    res.status(409).json({
      error: TeamErrorCode.INVITE_ALREADY_PENDING,
      message: error.message,
      invitationId: error.invitationId || undefined,
    });
    return;
  }
  if (error instanceof ConflictError) {
    // The conflict subclasses are each mapped by their own class name below;
    // an unmapped conflict is a programming mistake, so report it as one
    // instead of mislabelling it as a validation failure.
    const code = conflictCode(error);
    if (!code) {
      sendInternalError(res, error);
      return;
    }
    res.status(409).json({ error: code, message: error.message });
    return;
  }
  if (error instanceof InviteExpiredError) {
    res.status(410).json({ error: TeamErrorCode.INVITE_EXPIRED, message: error.message });
    return;
  }
  if (error instanceof InviteRevokedError) {
    res.status(410).json({ error: TeamErrorCode.INVITE_REVOKED, message: error.message });
    return;
  }
  if (error instanceof InviteNotFoundError) {
    res.status(404).json({ error: TeamErrorCode.INVITE_NOT_FOUND, message: error.message });
    return;
  }
  if (error instanceof DomainError) {
    const mapped = domainStatus(error.name);
    if (mapped) {
      res.status(mapped.status).json({ error: mapped.code, message: error.message });
      return;
    }
  }
  sendInternalError(res, error);
}

/** Error classes in the domain that describe a refusal, with their HTTP status. */
function domainStatus(name: string): { status: number; code: string } | null {
  switch (name) {
    case 'TeamMemberNotFoundError':
      return { status: 404, code: TeamErrorCode.MEMBER_NOT_FOUND };
    case 'SignInRequiredError':
      return { status: 401, code: TeamErrorCode.SIGN_IN_REQUIRED };
    case 'EmailMismatchError':
      return { status: 403, code: TeamErrorCode.EMAIL_MISMATCH };
    case 'UnauthorizedError':
      return { status: 401, code: TeamErrorCode.SIGN_IN_REQUIRED };
    default:
      return null;
  }
}

/** Conflict subclasses carry their contract code in the class name. */
function conflictCode(error: ConflictError): string | null {
  switch (error.name) {
    case 'InviteAlreadyMemberError':
      return TeamErrorCode.INVITE_ALREADY_MEMBER;
    case 'InviteResendConflictError':
      return TeamErrorCode.INVITE_RESEND_CONFLICT;
    case 'InviteAlreadyAcceptedError':
      return TeamErrorCode.INVITE_ALREADY_ACCEPTED;
    case 'LastOwnerError':
      return TeamErrorCode.LAST_OWNER;
    case 'SelfChangeNotAllowedError':
      return TeamErrorCode.SELF_CHANGE_NOT_ALLOWED;
    default:
      return null;
  }
}

teamRouter.use(requireAuth);

teamRouter.get('/', requireBusinessRole(ALLOWED_ROLES), async (_req: Request, res: Response) => {
  try {
    const { businessId } = actorFromContext();
    const data = await teamService.list(businessId);
    res.status(200).json({ success: true, data, message: 'Team loaded' });
  } catch (error) {
    sendError(res, error);
  }
});

teamRouter.post(
  '/invitations',
  requireBusinessRole(OWNER_ONLY),
  inviteWriteRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const parsed = InviteCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError(invalidFields(parsed.error.issues));
      }
      const { businessId, userId } = actorFromContext();
      const result = await teamService.invite(businessId, userId, parsed.data);
      setLinkHeaders(res);
      res.status(201).json({ success: true, data: result, message: 'Invitation created' });
    } catch (error) {
      setLinkHeaders(res);
      sendError(res, error);
    }
  },
);

teamRouter.post(
  '/invitations/:id/resend',
  requireBusinessRole(OWNER_ONLY),
  inviteWriteRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const { businessId, userId } = actorFromContext();
      const result = await teamService.resend(businessId, userId, String(req.params.id));
      setLinkHeaders(res);
      res.status(200).json({ success: true, data: result, message: 'Invitation resent' });
    } catch (error) {
      setLinkHeaders(res);
      sendError(res, error);
    }
  },
);

teamRouter.delete(
  '/invitations/:id',
  requireBusinessRole(OWNER_ONLY),
  async (req: Request, res: Response) => {
    try {
      const { businessId, userId } = actorFromContext();
      await teamService.cancel(businessId, userId, String(req.params.id));
      res.status(200).json({ success: true, message: 'Invitation cancelled' });
    } catch (error) {
      sendError(res, error);
    }
  },
);

teamRouter.patch(
  '/members/:id',
  requireBusinessRole(OWNER_ONLY),
  async (req: Request, res: Response) => {
    try {
      const parsed = MemberRoleUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError(invalidFields(parsed.error.issues));
      }
      const { businessId, userId } = actorFromContext();
      const member = await teamService.changeRole(
        businessId,
        userId,
        String(req.params.id),
        parsed.data.role,
      );
      res.status(200).json({ success: true, data: member, message: 'Role updated' });
    } catch (error) {
      sendError(res, error);
    }
  },
);

teamRouter.delete(
  '/members/:id',
  requireBusinessRole(OWNER_ONLY),
  async (req: Request, res: Response) => {
    try {
      const { businessId, userId } = actorFromContext();
      await teamService.removeMember(businessId, userId, String(req.params.id));
      res.status(200).json({ success: true, message: 'Member removed' });
    } catch (error) {
      sendError(res, error);
    }
  },
);

// --- Public invitation routes ---

/**
 * The optional caller identity on the public accept route. A token that is
 * present but unusable is treated as anonymous here, so the service can answer
 * with the specific reason (sign in first, or wrong address) instead of a
 * generic 401 that hides it.
 */
function optionalUserId(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  try {
    const decoded = jwt.verify(authHeader.substring(7), config.JWT_SECRET) as { userId?: string };
    return typeof decoded.userId === 'string' ? decoded.userId : undefined;
  } catch {
    return undefined;
  }
}

invitationRouter.get(
  '/:token',
  invitePreviewTokenRateLimiter,
  invitePreviewRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const data = await teamService.preview(String(req.params.token));
      setLinkHeaders(res);
      res.status(200).json({ success: true, data, message: 'Invitation loaded' });
    } catch (error) {
      setLinkHeaders(res);
      sendError(res, error);
    }
  },
);

invitationRouter.post(
  '/:token/accept',
  inviteAcceptTokenRateLimiter,
  inviteAcceptRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const parsed = InviteAcceptSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError(invalidFields(parsed.error.issues));
      }
      const result = await teamService.accept(
        String(req.params.token),
        parsed.data,
        optionalUserId(req),
      );

      setRefreshCookie(res, result.refreshToken);
      setLinkHeaders(res);
      res.status(200).json({
        success: true,
        data: { accessToken: result.accessToken, businessId: result.businessId },
        message: 'Invitation accepted',
      });
    } catch (error) {
      setLinkHeaders(res);
      sendError(res, error);
    }
  },
);
