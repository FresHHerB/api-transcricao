import { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  authenticated?: boolean;
}

export const authenticateToken = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    logger.warn(`🔐 Auth failed: Missing token - ${req.ip} ${req.path}`);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer token required'
    });
    return;
  }

  if (token !== config.apiKey) {
    logger.warn(`🔐 Auth failed: Invalid token - ${req.ip} ${req.path}`);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
    return;
  }

  logger.debug(`🔐 Auth success - ${req.ip} ${req.path}`);

  req.authenticated = true;
  next();
};