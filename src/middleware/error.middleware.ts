import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

/**
 * Central Express error handler.
 * A failed request never brings the process down.
 * Stack traces are logged server-side but never sent to the client in production.
 */
export function errorMiddleware(
  err: AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const statusCode = err.statusCode ?? 500;

  logger.error(
    {
      err,
      method: req.method,
      path: req.path,
      statusCode,
    },
    err.message,
  );

  if (err instanceof ZodError) {
    res.status(422).json({
      error: 'Validation error',
      issues: err.flatten().fieldErrors,
    });
    return;
  }

  res.status(statusCode).json({
    error: statusCode < 500 ? err.message : 'Internal server error',
    ...(err.code !== undefined && { code: err.code }),
  });
}
