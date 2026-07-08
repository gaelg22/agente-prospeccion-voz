import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Validates the `x-api-key` header for admin routes.
 * Returns 401 if the header is missing, 403 if it does not match.
 */
export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'];
  if (!key) {
    res.status(401).json({ error: 'Missing x-api-key header' });
    return;
  }
  if (key !== config.API_KEY) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }
  next();
}
