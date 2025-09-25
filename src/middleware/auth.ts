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
    logger.warn('Authentication failed: missing token', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path
    });

    res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer token required'
    });
    return;
  }

  if (token !== config.apiKey) {
    logger.warn('Authentication failed: invalid token', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
      providedToken: token.substring(0, 8) + '...'
    });

    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key'
    });
    return;
  }

  logger.debug('Authentication successful', {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    path: req.path
  });

  req.authenticated = true;
  next();
};