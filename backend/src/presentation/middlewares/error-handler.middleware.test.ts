import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { handleUnhandledError } from './error-handler.middleware.js';
import { INTERNAL_ERROR_MESSAGE } from '../controllers/internal-error.js';

function createResponse(headersSent = false) {
  const res = {
    headersSent,
    req: { method: 'GET', path: '/api/team' },
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('handleUnhandledError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A forwarded failure must reach the client as JSON, not Express's HTML page.
  it('answers with the shared JSON internal error envelope', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = createResponse();
    const next = vi.fn();

    handleUnhandledError(
      new Error('connection lost'),
      {} as Request,
      res as unknown as Response,
      next as NextFunction,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'INTERNAL_ERROR',
      message: INTERNAL_ERROR_MESSAGE,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('defers to the default handler when the response already started', () => {
    const res = createResponse(true);
    const next = vi.fn();
    const failure = new Error('late');

    handleUnhandledError(failure, {} as Request, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledWith(failure);
    expect(res.status).not.toHaveBeenCalled();
  });
});
