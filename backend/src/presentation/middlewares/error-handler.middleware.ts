import type { ErrorRequestHandler } from 'express';
import { sendInternalError } from '../controllers/internal-error.js';

/**
 * Terminal error handler. A route or middleware that forwards a failure with
 * next(error) lands here, so it answers with the same JSON envelope as every
 * other error instead of Express's default HTML page.
 */
export const handleUnhandledError: ErrorRequestHandler = (error, _req, res, next) => {
  // The response already started, so the only safe move is the default handler,
  // which closes the connection.
  if (res.headersSent) {
    next(error);
    return;
  }
  sendInternalError(res, error);
};
