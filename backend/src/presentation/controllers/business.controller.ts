import { Request, Response, Router } from 'express';
import multer from 'multer';
import { BusinessService } from '../../application/services/business.service.js';
import { requireAuth, requireBusinessRole } from '../middlewares/auth.middleware.js';
import { uploadRateLimiter } from '../middlewares/rate-limit.middleware.js';
import { DrizzleBusinessRepository } from '../../infrastructure/database/drizzle/repositories/business.repository.js';
import { CloudinaryService } from '../../infrastructure/services/cloudinary.service.js';
import { detectImageType } from '../../domain/image-type.js';
import {
  BusinessProfileSchema,
  BusinessProfileUpdateSchema,
  DraftSaveSchema,
} from '@f-commerce/contracts';
import { ConflictError, NotFoundError } from '../../domain/errors.js';
import {
  getTenantId,
  requestContext,
  runWithContext,
} from '../../infrastructure/database/drizzle/context.js';
import { sendInternalError } from './internal-error.js';

function getActorUserId(req: Request): string | undefined {
  const user = req.user as { userId?: unknown } | undefined;
  if (typeof user?.userId === 'string') {
    const trimmed = user.userId.trim();
    if (trimmed !== '') return trimmed;
  }
  const contextUserId = requestContext?.getStore?.()?.userId;
  if (typeof contextUserId === 'string') {
    const trimmed = contextUserId.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

export const businessRouter = Router();

const businessRepository = new DrizzleBusinessRepository();
const cloudinaryService = new CloudinaryService();
const businessService = new BusinessService(businessRepository, cloudinaryService);

businessRouter.use(requireAuth);

// Onboarding gate: block access for incomplete businesses, except onboarding routes
businessRouter.use((req, res, next) => {
  // Exempt onboarding completion, draft, and logo upload endpoints
  if (req.path === '/onboarding' || req.path.startsWith('/onboarding/') || req.path === '/logo') {
    next();
    return;
  }

  // Use the x-business-id header (consistent with requireBusinessRole) so that
  // STAFF users with multiple memberships are evaluated against the business
  // they are actually targeting, not always memberships[0].
  const businessId = req.headers['x-business-id'] as string | undefined;
  if (!businessId) {
    res
      .status(400)
      .json({ error: 'Missing x-business-id header', message: 'Missing x-business-id header' });
    return;
  }

  const user = req.user as {
    userId: string;
    memberships: { businessId: string; role: 'OWNER' | 'STAFF' }[];
  };
  const membership = user?.memberships?.find((m) => m.businessId === businessId);

  // Reject callers who are not a member of the business they are targeting.
  // Without this, a non-member's request would run a DB lookup against a
  // business they have no relationship with, leaking its existence and
  // onboarding status via the response code.
  if (!membership) {
    res.status(403).json({
      error: 'Insufficient permissions',
      message: 'You are not a member of this business',
    });
    return;
  }

  // Run the DB lookup inside the tenant context so the query is isolated
  // even if the Business model later adopts the tenant plugin.
  runWithContext(
    {
      userId: user.userId,
      businessId,
      role: membership.role,
    },
    async () => {
      try {
        const business = await businessService.getBusiness(businessId);
        if (!business || !business.onboardingComplete) {
          res.status(403).json({
            error: 'Onboarding required',
            message: 'Please complete your business profile before accessing this resource',
          });
          return;
        }
        next();
      } catch {
        res
          .status(500)
          .json({ error: 'Internal server error', message: 'Failed to verify onboarding status' });
      }
    },
  );
});

businessRouter.get(
  '/me',
  requireBusinessRole(['OWNER', 'STAFF']),
  async (req: Request, res: Response) => {
    try {
      // Use tenant context businessId set by requireBusinessRole middleware
      const businessId = getTenantId();
      if (!businessId) {
        res.status(400).json({ error: 'No business context', message: 'Missing business context' });
        return;
      }

      const business = await businessService.getBusiness(businessId);
      if (!business) {
        res.status(404).json({ error: 'Business not found', message: 'Business not found' });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          name: business.name,
          currency: business.currency,
          timezone: business.timezone,
          logoUrl: business.logoUrl ?? null,
          address: business.address ?? null,
          onboardingComplete: business.onboardingComplete,
          onboardingDraft: business.onboardingDraft,
        },
        message: 'Business profile retrieved',
      });
    } catch (error) {
      sendInternalError(res, error);
    }
  },
);

businessRouter.get(
  '/onboarding',
  requireBusinessRole(['OWNER']),
  async (req: Request, res: Response) => {
    try {
      const businessId = getTenantId();
      if (!businessId) {
        res.status(400).json({ error: 'No business context', message: 'Missing business context' });
        return;
      }

      const business = await businessService.getBusiness(businessId);
      if (!business) {
        res.status(404).json({ error: 'Business not found', message: 'Business not found' });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          name: business.name,
          currency: business.currency,
          timezone: business.timezone,
          logoUrl: business.logoUrl ?? null,
          address: business.address ?? null,
          onboardingComplete: business.onboardingComplete,
          onboardingDraft: business.onboardingDraft ?? null,
        },
        message: 'Onboarding state retrieved',
      });
    } catch (error) {
      sendInternalError(res, error);
    }
  },
);

businessRouter.put('/me', requireBusinessRole(['OWNER']), async (req: Request, res: Response) => {
  try {
    const parsed = BusinessProfileUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.format() });
      return;
    }

    // Use tenant context businessId set by requireBusinessRole middleware
    const businessId = getTenantId();
    if (!businessId) {
      res.status(400).json({ error: 'No business context', message: 'Missing business context' });
      return;
    }

    const actorUserId = getActorUserId(req);
    if (!actorUserId) {
      res
        .status(401)
        .json({ error: 'Authentication required', message: 'Authentication required' });
      return;
    }

    const business = await businessService.updateBusiness(businessId, parsed.data, actorUserId);
    if (!business) {
      res.status(404).json({ error: 'Business not found', message: 'Business not found' });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        name: business.name,
        currency: business.currency,
        timezone: business.timezone,
        logoUrl: business.logoUrl ?? null,
        address: business.address ?? null,
        onboardingComplete: business.onboardingComplete,
      },
      message: 'Business profile updated',
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(404).json({ error: error.message });
    } else {
      sendInternalError(res, error);
    }
  }
});

businessRouter.post(
  '/logo',
  requireBusinessRole(['OWNER']),
  uploadRateLimiter,
  upload.single('image'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded', message: 'Please upload an image file' });
      return;
    }

    const maxSize = 5 * 1024 * 1024;
    if (req.file.size > maxSize) {
      res.status(400).json({ error: 'File too large', message: 'Maximum file size is 5MB' });
      return;
    }

    // Validate file by magic bytes (MIME type from header is attacker-controlled)
    const detectedType = detectImageType(req.file.buffer);
    if (!detectedType) {
      res.status(400).json({
        error: 'Invalid file type',
        message: 'Only JPEG, PNG, GIF, and WebP images are allowed',
      });
      return;
    }

    // Use tenant context businessId set by requireBusinessRole middleware
    const businessId = getTenantId();
    if (!businessId) {
      res.status(400).json({ error: 'No business context', message: 'Missing business context' });
      return;
    }

    const actorUserId = getActorUserId(req);
    if (!actorUserId) {
      res
        .status(401)
        .json({ error: 'Authentication required', message: 'Authentication required' });
      return;
    }

    // Only the Cloudinary call maps to a 502. A persistence or audit failure is
    // a server error, so it goes to the global handler instead of claiming the
    // upload failed.
    let logoUrl: string;
    try {
      const result = await businessService.uploadLogo(businessId, req.file.buffer);
      logoUrl = result.logoUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(502).json({ error: 'Cloudinary upload failed', message });
      return;
    }

    // Persist the logo URL to the business so it's available during onboarding
    const updated = await businessService.updateBusiness(businessId, { logoUrl }, actorUserId);
    if (!updated) {
      res.status(404).json({ error: 'Business not found', message: 'Business not found' });
      return;
    }

    res.status(200).json({
      success: true,
      data: { logoUrl },
      message: 'Logo uploaded successfully',
    });
  },
);

businessRouter.put(
  '/onboarding',
  requireBusinessRole(['OWNER']),
  async (req: Request, res: Response) => {
    try {
      const parsed = BusinessProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.format() });
        return;
      }

      // Use tenant context businessId set by requireBusinessRole middleware
      const businessId = getTenantId();
      if (!businessId) {
        res.status(400).json({ error: 'No business context', message: 'Missing business context' });
        return;
      }

      const actorUserId = getActorUserId(req);
      if (!actorUserId) {
        res
          .status(401)
          .json({ error: 'Authentication required', message: 'Authentication required' });
        return;
      }

      const { name, currency, timezone, address, logoUrl } = parsed.data;
      const business = await businessService.completeOnboarding(
        businessId,
        {
          name,
          currency,
          timezone,
          address,
          logoUrl,
        },
        actorUserId,
      );

      if (!business) {
        res.status(404).json({ error: 'Business not found', message: 'Business not found' });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          name: business.name,
          currency: business.currency,
          timezone: business.timezone,
          logoUrl: business.logoUrl ?? null,
          address: business.address ?? null,
          onboardingComplete: business.onboardingComplete,
        },
        message: 'Onboarding completed',
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else if (error instanceof ConflictError) {
        res.status(409).json({ error: 'ONBOARDING_COMPLETE', message: error.message });
      } else {
        sendInternalError(res, error);
      }
    }
  },
);

businessRouter.put(
  '/onboarding/draft',
  requireBusinessRole(['OWNER']),
  async (req: Request, res: Response) => {
    try {
      const parsed = DraftSaveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.format() });
        return;
      }

      const { field, value } = parsed.data;
      // Use tenant context businessId set by requireBusinessRole middleware
      const businessId = getTenantId();
      if (!businessId) {
        res.status(400).json({ error: 'No business context', message: 'Missing business context' });
        return;
      }

      // A write is skipped once onboarding completes, so answer 409 rather than
      // reporting a save that never happened.
      const saved = await businessService.saveDraft(businessId, field, value);
      if (!saved) {
        res.status(409).json({
          error: 'ONBOARDING_COMPLETE',
          message: 'Onboarding is already complete, so there is no draft to save',
        });
        return;
      }

      res.status(200).json({ success: true, message: 'Draft saved' });
    } catch (error) {
      sendInternalError(res, error);
    }
  },
);
