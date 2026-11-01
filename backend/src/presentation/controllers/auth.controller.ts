import { CookieOptions, Request, Response, Router } from 'express';
import { AuthService } from '../../application/services/auth.service.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { config } from '../../infrastructure/config.js';
import { RegisterSchema, LoginSchema, OAuthLoginSchema } from '@f-commerce/contracts';
import { DrizzleAuthRepository } from '../../infrastructure/database/drizzle/repositories/auth.repository.js';
import { DuplicateEmailError, UnauthorizedError, NotFoundError } from '../../domain/errors.js';
import { sendInternalError } from './internal-error.js';

export const authRouter = Router();

// Instantiate repository and service (simple DI for now)
const authRepository = new DrizzleAuthRepository();
const authService = new AuthService(authRepository);

/**
 * The refresh token stays in a host only cookie scoped to the frontend origin.
 * Browser code reaches the API only through the Next.js proxy on that same
 * origin, which is what keeps the cookie first party. A client that called the
 * API on another domain would stop sending it; that topology needs
 * `SameSite=None`, a secure cookie, and an explicit CSRF defense.
 */
const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'strict',
};

function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie('refreshToken', refreshToken, refreshCookieOptions);
}

authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.format() });
      return;
    }
    const { email, password, name, businessName } = parsed.data;
    const tokens = await authService.register(email, password, name, businessName);

    // Extract businessId from the access token payload
    let businessId: string | undefined;
    try {
      const payload = tokens.accessToken.split('.')[1];
      if (payload) {
        businessId = JSON.parse(Buffer.from(payload, 'base64').toString()).memberships?.[0]
          ?.businessId;
      }
    } catch {
      // Token decode failed, leave businessId undefined
    }

    setRefreshCookie(res, tokens.refreshToken);
    res.status(201).json({ accessToken: tokens.accessToken, businessId });
  } catch (error) {
    if (error instanceof DuplicateEmailError) {
      res.status(409).json({ error: error.message });
    } else {
      sendInternalError(res, error);
    }
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.format() });
      return;
    }
    const { email, password } = parsed.data;
    const tokens = await authService.login(email, password);

    // Extract businessId from the access token payload
    let businessId: string | undefined;
    try {
      const payload = tokens.accessToken.split('.')[1];
      if (payload) {
        businessId = JSON.parse(Buffer.from(payload, 'base64').toString()).memberships?.[0]
          ?.businessId;
      }
    } catch {
      // Token decode failed, leave businessId undefined
    }

    setRefreshCookie(res, tokens.refreshToken);
    res.status(200).json({ accessToken: tokens.accessToken, businessId });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      res.status(401).json({ error: error.message });
    } else {
      sendInternalError(res, error);
    }
  }
});

authRouter.post('/oauth/:provider', async (req: Request, res: Response) => {
  try {
    if (config.NODE_ENV === 'production') {
      res.status(501).json({ error: 'OAuth mock login is disabled in production' });
      return;
    }

    const provider = req.params.provider as string;
    const parsed = OAuthLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', details: parsed.error.format() });
      return;
    }
    const { email, name, providerId } = parsed.data;

    const tokens = await authService.oauthLogin(email, name, provider, providerId);

    // Extract businessId from the access token payload
    let businessId: string | undefined;
    try {
      const payload = tokens.accessToken.split('.')[1];
      if (payload) {
        businessId = JSON.parse(Buffer.from(payload, 'base64').toString()).memberships?.[0]
          ?.businessId;
      }
    } catch {
      // Token decode failed, leave businessId undefined
    }

    setRefreshCookie(res, tokens.refreshToken);
    res.status(200).json({ accessToken: tokens.accessToken, businessId });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      res.status(401).json({ error: error.message });
    } else {
      sendInternalError(res, error);
    }
  }
});

authRouter.post('/refresh', async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      res.status(400).json({ error: 'No refresh token provided' });
      return;
    }

    const tokens = await authService.refresh(refreshToken);
    setRefreshCookie(res, tokens.refreshToken);
    res.status(200).json({ accessToken: tokens.accessToken });
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof NotFoundError) {
      res.status(401).json({ error: error.message });
    } else {
      sendInternalError(res, error);
    }
  }
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      await authService.logout(refreshToken);
      res.clearCookie('refreshToken');
    }
    res.status(200).json({ success: true });
  } catch (error) {
    sendInternalError(res, error);
  }
});

authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const profile = await authService.getProfile(userId);
    res.status(200).json(profile);
  } catch (error) {
    if (error instanceof NotFoundError) {
      res.status(404).json({ error: error.message });
    } else {
      sendInternalError(res, error);
    }
  }
});
