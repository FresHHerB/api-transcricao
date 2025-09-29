import { Router, Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { CaptionRequest, CaptionResponse } from '../types';
import { FFmpegService } from '../services/ffmpegService';
import Joi from 'joi';
import { basename } from 'path';

const router = Router();
const ffmpegService = new FFmpegService();

const captionRequestSchema = Joi.object({
  url_video: Joi.string().uri().required(),
  url_srt: Joi.string().uri().required()
});

router.post('/caption',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    const requestId = `caption_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    try {
      const { error: validationError, value: requestData } = captionRequestSchema.validate(req.body);

      if (validationError) {
        logger.warn('Invalid caption request parameters', {
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

      const { url_video, url_srt } = requestData as CaptionRequest;

      logger.info('🚀 NOVA REQUISIÇÃO DE CAPTION', {
        requestId,
        url_video,
        url_srt,
        ip: req.ip,
        userAgent: req.get('User-Agent')?.substring(0, 50) + '...',
        timestamp: new Date().toISOString()
      });

      // Check FFmpeg availability
      const healthCheck = await ffmpegService.healthCheck();
      if (!healthCheck.ffmpegAvailable) {
        logger.error('❌ FFmpeg not available', {
          requestId,
          healthCheck
        });

        res.status(503).json({
          error: 'Service unavailable',
          message: 'FFmpeg is not available on this server',
          requestId
        });
        return;
      }

      logger.info('✅ FFmpeg health check passed', {
        requestId,
        ffmpegVersion: healthCheck.version
      });

      logger.info('🎬 FASE 1: Iniciando processamento de caption', {
        requestId,
        url_video,
        url_srt,
        phase: 'CAPTION_PROCESSING_START'
      });

      const { outputPath, stats } = await ffmpegService.addCaptionsToVideo(
        url_video,
        url_srt,
        requestId
      );

      const endTime = Date.now();
      const processingTime = endTime - startTime;

      // Generate public URL for the output video
      const outputFilename = basename(outputPath);
      const videoUrl = `${req.protocol}://${req.get('host')}/output/${outputFilename}`;

      const response: CaptionResponse = {
        code: 200,
        message: 'Video caption added successfully',
        video_url: videoUrl,
        execution: {
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          durationMs: processingTime,
          durationSeconds: Math.round(processingTime / 1000 * 100) / 100
        },
        stats: {
          ...stats,
          ffmpegCommand: `ffmpeg -y -i "${url_video}" -vf "subtitles=filename='${url_srt}'" -c:v libx264 -preset veryfast -crf 20 -c:a copy -movflags +faststart "${outputFilename}"`
        }
      };

      const logStats = {
        requestId,
        processingTimeMs: processingTime,
        processingTimeMin: (processingTime / 60000).toFixed(2),
        inputVideoSizeMB: stats.inputVideoSize ? Math.round(stats.inputVideoSize / 1024 / 1024 * 100) / 100 : 'unknown',
        outputVideoSizeMB: stats.outputVideoSize ? Math.round(stats.outputVideoSize / 1024 / 1024 * 100) / 100 : 'unknown',
        compressionRatio: stats.compressionRatio,
        outputPath,
        videoUrl
      };

      logger.info('🎉 CAPTION CONCLUÍDO COM SUCESSO!', logStats);

      res.json(response);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const processingTime = Date.now() - startTime;

      logger.error('💥 CAPTION FALHOU', {
        requestId,
        error: errorMessage,
        processingTimeMs: processingTime,
        processingTimeMin: (processingTime / 60000).toFixed(2),
        ip: req.ip,
        timestamp: new Date().toISOString()
      });

      if (errorMessage.includes('Failed to download')) {
        res.status(422).json({
          error: 'Download failed',
          message: 'Failed to download video or SRT file',
          requestId
        });
      } else if (errorMessage.includes('SRT validation failed')) {
        res.status(422).json({
          error: 'Invalid SRT file',
          message: 'The provided SRT file is not valid',
          requestId
        });
      } else if (errorMessage.includes('FFmpeg failed')) {
        res.status(422).json({
          error: 'Video processing failed',
          message: 'Failed to process video with captions',
          requestId
        });
      } else if (errorMessage.includes('timeout') || errorMessage.includes('ECONNABORTED')) {
        res.status(504).json({
          error: 'Request timeout',
          message: 'Video processing took too long to complete',
          requestId
        });
      } else if (errorMessage.includes('FFmpeg spawn error')) {
        res.status(503).json({
          error: 'Service unavailable',
          message: 'Video processing service is not available',
          requestId
        });
      } else {
        res.status(500).json({
          error: 'Caption processing failed',
          message: errorMessage,
          requestId
        });
      }
    }
  }
);

// Health check endpoint for caption service
router.get('/caption/health', async (req: Request, res: Response) => {
  try {
    const healthCheck = await ffmpegService.healthCheck();

    res.json({
      service: 'Caption Service',
      status: healthCheck.ffmpegAvailable ? 'healthy' : 'unhealthy',
      ffmpeg: healthCheck,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      service: 'Caption Service',
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;