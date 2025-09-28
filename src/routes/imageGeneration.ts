import { Router, Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { GenerateImageRequest, GenerateImageResponse, SceneData } from '../types';
import { OpenRouterService } from '../services/openRouterService';
import { RunwareService } from '../services/runwareService';
import { RunwareWebSocketService } from '../services/runwareWebSocketService';
import Joi from 'joi';

const router = Router();
const openRouterService = new OpenRouterService();
const runwareService = new RunwareService();
const runwareWebSocketService = new RunwareWebSocketService();

const sceneSchema = Joi.object({
  index: Joi.number().integer().min(0).required(),
  texto: Joi.string().min(1).required()
});

const generateImageRequestSchema = Joi.object({
  cenas: Joi.array().items(sceneSchema).min(1).max(10).required(),
  image_model: Joi.string().min(1).max(100).required(),
  altura: Joi.number().integer().min(512).max(2048).required(),
  largura: Joi.number().integer().min(512).max(2048).required(),
  estilo: Joi.string().min(1).max(500).required(),
  detalhe_estilo: Joi.string().min(1).max(1000).required(),
  roteiro: Joi.string().min(1).required(),
  agente: Joi.string().min(1).required()
});

router.post('/generateImage',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    const requestId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    try {
      const { error: validationError, value: requestData } = generateImageRequestSchema.validate(req.body);

      if (validationError) {
        logger.warn('Invalid generateImage request parameters', {
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
        image_model,
        altura,
        largura,
        estilo,
        detalhe_estilo,
        roteiro,
        agente
      } = requestData as GenerateImageRequest;

      logger.info('🚀 NOVA REQUISIÇÃO DE GERAÇÃO DE IMAGENS', {
        requestId,
        totalScenes: cenas.length,
        image_model,
        dimensions: `${largura}x${altura}`,
        estilo,
        ip: req.ip,
        userAgent: req.get('User-Agent')?.substring(0, 50) + '...',
        timestamp: new Date().toISOString()
      });

      logger.info('🎭 FASE 1: Gerando prompts com OpenRouter', {
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

      logger.info('✅ FASE 1 CONCLUÍDA: Prompts gerados', {
        requestId,
        promptsGenerated: prompts.length,
        requestedScenes: cenas.length,
        phase: 'PROMPT_GENERATION_SUCCESS'
      });

      logger.info('🖼️ FASE 2: Gerando imagens com Runware WebSocket', {
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

      const response: GenerateImageResponse = {
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
          totalScenes: cenas.length,
          promptsGenerated: prompts.length,
          imagesGenerated: images.length,
          successRate: `${((images.length / cenas.length) * 100).toFixed(1)}%`
        }
      };

      const stats = {
        requestId,
        processingTimeMs: processingTime,
        processingTimeMin: (processingTime / 60000).toFixed(2),
        totalScenes: cenas.length,
        promptsGenerated: prompts.length,
        imagesGenerated: images.length,
        successRate: `${((images.length / cenas.length) * 100).toFixed(1)}%`,
        image_model,
        dimensions: `${largura}x${altura}`,
        estilo
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

      if (errorMessage.includes('OpenRouter API failed')) {
        res.status(503).json({
          error: 'Prompt generation service unavailable',
          message: 'Failed to generate prompts for image generation',
          requestId
        });
      } else if (errorMessage.includes('Runware API failed') || errorMessage.includes('Runware WebSocket API failed')) {
        res.status(503).json({
          error: 'Image generation service unavailable',
          message: 'Failed to generate images',
          requestId
        });
      } else if (errorMessage.includes('No prompts were generated') || errorMessage.includes('No images were generated')) {
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