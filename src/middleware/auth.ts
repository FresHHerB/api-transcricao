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
  // Check for X-API-Key header first, then Bearer token as fallback
  const xApiKey = req.headers['x-api-key'] as string;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  const token = xApiKey || bearerToken;

  if (!token) {
    logger.warn(`🔐 Auth failed: Missing API key - ${req.ip} ${req.path}`);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'X-API-Key header or Bearer token required'
    });
    return;
  }

  if (token !== config.apiKey) {
    logger.warn(`🔐 Auth failed: Invalid API key - ${req.ip} ${req.path}`);
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