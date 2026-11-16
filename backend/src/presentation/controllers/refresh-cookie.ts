import type { CookieOptions, Response } from 'express';
import { config } from '../../infrastructure/config.js';

/**
 * The refresh token stays in a host only cookie scoped to the frontend origin.
 * Browser code reaches the API only through the Next.js proxy on that same
 * origin, which is what keeps the cookie first party. A client that called the
 * API on another domain would stop sending it; that topology needs
 * `SameSite=None`, a secure cookie, and an explicit CSRF defense.
 */
export const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'strict',
};

/** One cookie shape for every route that starts or refreshes a session. */
export function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie('refreshToken', refreshToken, refreshCookieOptions);
}
