import { Router, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import Joi from 'joi';

const router = Router();

// Storage for IP address
let storedIpAddress: string | null = null;

// Validation schema for IP address
const ipAddressSchema = Joi.object({
  endereco: Joi.string().ip({ version: ['ipv4', 'ipv6'] }).required()
});

// POST endpoint to store IP address
router.post('/endereco',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    const requestId = `endereco_post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      const { error: validationError, value: requestData } = ipAddressSchema.validate(req.body);

      if (validationError) {
        logger.warn('Invalid IP address format', {
          requestId,
          error: validationError.message,
          body: req.body
        });

        res.status(400).json({
          error: 'Invalid parameters',
          message: validationError.message,
          requestId
        });
        return;
      }

      const { endereco } = requestData;
      storedIpAddress = endereco;

      logger.info('📍 IP Address stored successfully', {
        requestId,
        endereco: storedIpAddress,
        timestamp: new Date().toISOString()
      });

      res.status(200).json({
        message: 'IP address stored successfully',
        endereco: storedIpAddress,
        requestId
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('💥 Failed to store IP address', {
        requestId,
        error: errorMessage,
        timestamp: new Date().toISOString()
      });

      res.status(500).json({
        error: 'Failed to store IP address',
        message: errorMessage,
        requestId
      });
    }
  }
);

// GET endpoint to retrieve stored IP address
router.get('/endereco',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    const requestId = `endereco_get_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      if (!storedIpAddress) {
        logger.warn('No IP address stored', {
          requestId,
          timestamp: new Date().toISOString()
        });

        res.status(404).json({
          error: 'No IP address stored',
          message: 'Please POST an IP address first',
          requestId
        });
        return;
      }

      logger.info('📍 IP Address retrieved successfully', {
        requestId,
        endereco: storedIpAddress,
        timestamp: new Date().toISOString()
      });

      res.status(200).json({
        endereco: storedIpAddress,
        requestId
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('💥 Failed to retrieve IP address', {
        requestId,
        error: errorMessage,
        timestamp: new Date().toISOString()
      });

      res.status(500).json({
        error: 'Failed to retrieve IP address',
        message: errorMessage,
        requestId
      });
    }
  }
);

export default router;
