import { Router, Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import {
  GerarPromptsRequest,
  GerarPromptsResponse,
  GerarImagensRequest,
  GerarImagensResponse,
  SceneData,
  PromptData
} from '../types';
import { OpenRouterService } from '../services/openRouterService';
import { RunwareWebSocketService } from '../services/runwareWebSocketService';
import Joi from 'joi';

const router = Router();
const openRouterService = new OpenRouterService();
const runwareWebSocketService = new RunwareWebSocketService();

// Validation schemas
const sceneSchema = Joi.object({
  index: Joi.number().integer().min(0).required(),
  texto: Joi.string().min(1).required()
});

const promptDataSchema = Joi.object({
  index: Joi.number().integer().min(0).required(),
  prompt: Joi.string().min(1).required()
});

const gerarPromptsRequestSchema = Joi.object({
  cenas: Joi.array().items(sceneSchema).min(1).required(),
  estilo: Joi.string().min(1).max(500).required(),
  detalhe_estilo: Joi.string().min(1).max(1000).required(),
  roteiro: Joi.string().min(1).required(),
  agente: Joi.string().min(1).required()
});

const gerarImagensRequestSchema = Joi.object({
  prompts: Joi.array().items(promptDataSchema).min(1).required(),
  image_model: Joi.string().min(1).max(100).required(),
  altura: Joi.number().integer().min(512).max(2048).required(),
  largura: Joi.number().integer().min(512).max(2048).required()
});

// ENDPOINT 1: Generate Prompts
router.post('/gerarPrompts',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    const requestId = `prompts_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    try {
      const { error: validationError, value: requestData } = gerarPromptsRequestSchema.validate(req.body);

      if (validationError) {
        logger.warn('Invalid gerarPrompts request parameters', {
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

      const {
        cenas,
        estilo,
        detalhe_estilo,
        roteiro,
        agente
      } = requestData as GerarPromptsRequest;

      logger.info('🚀 NOVA REQUISIÇÃO DE GERAÇÃO DE PROMPTS', {
        requestId,
        totalScenes: cenas.length,
        estilo,
        ip: req.ip,
        userAgent: req.get('User-Agent')?.substring(0, 50) + '...',
        timestamp: new Date().toISOString()
      });

      logger.info('🎭 Gerando prompts com OpenRouter', {
        requestId,
        totalScenes: cenas.length,
        phase: 'PROMPT_GENERATION_START'
      });

      const prompts = await openRouterService.generatePromptsForScenes(
        cenas,
        estilo,
        detalhe_estilo,
        roteiro,
        agente
      );

      if (prompts.length === 0) {
        throw new Error('No prompts were generated successfully');
      }

      const endTime = Date.now();
      const processingTime = endTime - startTime;

      const response: GerarPromptsResponse = {
        code: 200,
        message: 'Prompts generated successfully',
        prompts: prompts.sort((a, b) => a.index - b.index),
        execution: {
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          durationMs: processingTime,
          durationSeconds: Math.round(processingTime / 1000 * 100) / 100
        },
        stats: {
          totalScenes: cenas.length,
          promptsGenerated: prompts.length,
          successRate: `${((prompts.length / cenas.length) * 100).toFixed(1)}%`
        }
      };

      const stats = {
        requestId,
        processingTimeMs: processingTime,
        processingTimeMin: (processingTime / 60000).toFixed(2),
        totalScenes: cenas.length,
        promptsGenerated: prompts.length,
        successRate: `${((prompts.length / cenas.length) * 100).toFixed(1)}%`,
        estilo
      };

      logger.info('🎉 GERAÇÃO DE PROMPTS CONCLUÍDA COM SUCESSO!', stats);

      res.json(response);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const processingTime = Date.now() - startTime;

      logger.error('💥 GERAÇÃO DE PROMPTS FALHOU', {
        requestId,
        error: errorMessage,
        processingTimeMs: processingTime,
        processingTimeMin: (processingTime / 60000).toFixed(2),
        ip: req.ip,
        timestamp: new Date().toISOString()
      });

      if (errorMessage.includes('OpenRouter API failed')) {
        res.status(503).json({
          error: 'Prompt generation service unavailable',
          message: 'Failed to generate prompts',
          requestId
        });
      } else if (errorMessage.includes('No prompts were generated')) {
        res.status(422).json({
          error: 'Generation failed',
          message: errorMessage,
          requestId
        });
      } else if (errorMessage.includes('timeout') || errorMessage.includes('ECONNABORTED')) {
        res.status(504).json({
          error: 'Request timeout',
          message: 'Prompt generation took too long to complete',
          requestId
        });
      } else if (errorMessage.includes('Rate limit') || errorMessage.includes('429')) {
        res.status(429).json({
          error: 'Rate limit exceeded',
          message: 'Too many requests, please try again later',
          requestId
        });
      } else if (errorMessage.includes('Invalid API key') || errorMessage.includes('401')) {
        res.status(503).json({
          error: 'Service configuration error',
          message: 'External service authentication failed',
          requestId
        });
      } else if (errorMessage.includes('Insufficient credits') || errorMessage.includes('402')) {
        res.status(503).json({
          error: 'Service unavailable',
          message: 'External service credits exhausted',
          requestId
        });
      } else {
        res.status(500).json({
          error: 'Prompt generation failed',
          message: errorMessage,
          requestId
        });
      }
    }
  }
);

// ENDPOINT 2: Generate Images
router.post('/gerarImagens',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    const requestId = `images_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    try {
      const { error: validationError, value: requestData } = gerarImagensRequestSchema.validate(req.body);

      if (validationError) {
        logger.warn('Invalid gerarImagens request parameters', {
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

      const {
        prompts,
        image_model,
        altura,
        largura
      } = requestData as GerarImagensRequest;

      logger.info('🚀 NOVA REQUISIÇÃO DE GERAÇÃO DE IMAGENS', {
        requestId,
        totalPrompts: prompts.length,
        image_model,
        dimensions: `${largura}x${altura}`,
        ip: req.ip,
        userAgent: req.get('User-Agent')?.substring(0, 50) + '...',
        timestamp: new Date().toISOString()
      });

      logger.info('🖼️ Gerando imagens com Runware WebSocket', {
        requestId,
        totalImages: prompts.length,
        image_model,
        dimensions: `${largura}x${altura}`,
        phase: 'IMAGE_GENERATION_START'
      });

      const images = await runwareWebSocketService.generateImagesForScenes(
        prompts,
        image_model,
        largura,
        altura
      );

      if (images.length === 0) {
        throw new Error('No images were generated successfully');
      }

      const endTime = Date.now();
      const processingTime = endTime - startTime;

      const response: GerarImagensResponse = {
        code: 200,
        message: 'Images generated successfully',
        images: images.sort((a, b) => a.index - b.index),
        execution: {
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          durationMs: processingTime,
          durationSeconds: Math.round(processingTime / 1000 * 100) / 100
        },
        stats: {
          totalPrompts: prompts.length,
          imagesGenerated: images.length,
          successRate: `${((images.length / prompts.length) * 100).toFixed(1)}%`
        }
      };

      const stats = {
        requestId,
        processingTimeMs: processingTime,
        processingTimeMin: (processingTime / 60000).toFixed(2),
        totalPrompts: prompts.length,
        imagesGenerated: images.length,
        successRate: `${((images.length / prompts.length) * 100).toFixed(1)}%`,
        image_model,
        dimensions: `${largura}x${altura}`
      };

      logger.info('🎉 GERAÇÃO DE IMAGENS CONCLUÍDA COM SUCESSO!', stats);

      res.json(response);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const processingTime = Date.now() - startTime;

      logger.error('💥 GERAÇÃO DE IMAGENS FALHOU', {
        requestId,
        error: errorMessage,
        processingTimeMs: processingTime,
        processingTimeMin: (processingTime / 60000).toFixed(2),
        ip: req.ip,
        timestamp: new Date().toISOString()
      });

      if (errorMessage.includes('Runware API failed') || errorMessage.includes('Runware WebSocket API failed')) {
        res.status(503).json({
          error: 'Image generation service unavailable',
          message: 'Failed to generate images',
          requestId
        });
      } else if (errorMessage.includes('No images were generated')) {
        res.status(422).json({
          error: 'Generation failed',
          message: errorMessage,
          requestId
        });
      } else if (errorMessage.includes('timeout') || errorMessage.includes('ECONNABORTED')) {
        res.status(504).json({
          error: 'Request timeout',
          message: 'Image generation took too long to complete',
          requestId
        });
      } else if (errorMessage.includes('Rate limit') || errorMessage.includes('429')) {
        res.status(429).json({
          error: 'Rate limit exceeded',
          message: 'Too many requests, please try again later',
          requestId
        });
      } else if (errorMessage.includes('Invalid API key') || errorMessage.includes('401')) {
        res.status(503).json({
          error: 'Service configuration error',
          message: 'External service authentication failed',
          requestId
        });
      } else if (errorMessage.includes('Insufficient credits') || errorMessage.includes('402')) {
        res.status(503).json({
          error: 'Service unavailable',
          message: 'External service credits exhausted',
          requestId
        });
      } else {
        res.status(500).json({
          error: 'Image generation failed',
          message: errorMessage,
          requestId
        });
      }
    }
  }
);

// Graceful shutdown handling for WebSocket connections
process.on('SIGTERM', async () => {
  logger.info('🔌 Shutting down WebSocket connections...');
  await runwareWebSocketService.shutdown();
});

process.on('SIGINT', async () => {
  logger.info('🔌 Shutting down WebSocket connections...');
  await runwareWebSocketService.shutdown();
});

export default router;