import { Router, Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { CaptionRequest, CaptionResponse, Img2VidRequest, Img2VidResponse, AddAudioRequest, AddAudioResponse } from '../types';
import { FFmpegService } from '../services/ffmpegService';
import { cleanupService } from '../services/cleanupService';
import Joi from 'joi';
import { basename } from 'path';

const router = Router();
const ffmpegService = new FFmpegService();

// Validation schemas
const captionRequestSchema = Joi.object({
  url_video: Joi.string().min(1).required().custom((value, helpers) => {
    // Allow internal MinIO URLs and standard URLs
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    return helpers.error('any.invalid');
  }, 'URL validation'),
  url_srt: Joi.string().min(1).required().custom((value, helpers) => {
    // Allow internal MinIO URLs and standard URLs
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    return helpers.error('any.invalid');
  }, 'URL validation')
});

const img2VidRequestSchema = Joi.object({
  url_image: Joi.string().min(1).required().custom((value, helpers) => {
    // Allow internal MinIO URLs and standard URLs
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    return helpers.error('any.invalid');
  }, 'URL validation'),
  frame_rate: Joi.number().min(1).max(60).default(24),
  duration: Joi.number().min(0.1).max(60).required()
});

const addAudioRequestSchema = Joi.object({
  url_video: Joi.string().min(1).required().custom((value, helpers) => {
    // Allow internal MinIO URLs and standard URLs
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    return helpers.error('any.invalid');
  }, 'URL validation'),
  url_audio: Joi.string().min(1).required().custom((value, helpers) => {
    // Allow internal MinIO URLs and standard URLs
    if (value.startsWith('http://') || value.startsWith('https://')) {
      return value;
    }
    return helpers.error('any.invalid');
  }, 'URL validation')
});

// ENDPOINT 1: Video Caption (moved from /caption to /video/caption)
router.post('/video/caption',
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

// ENDPOINT 2: Image to Video with Zoom Effect
router.post('/video/img2vid',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    const requestId = `img2vid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    try {
      const { error: validationError, value: requestData } = img2VidRequestSchema.validate(req.body);

      if (validationError) {
        logger.warn('Invalid img2vid request parameters', {
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

      const { url_image, frame_rate, duration } = requestData as Img2VidRequest;

      logger.info('🚀 NOVA REQUISIÇÃO DE IMG2VID', {
        requestId,
        url_image,
        frame_rate,
        duration,
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

      logger.info('🎥 FASE 1: Iniciando conversão img2vid com zoom', {
        requestId,
        url_image,
        frame_rate,
        duration,
        phase: 'IMG2VID_PROCESSING_START'
      });

      const { outputPath, stats } = await ffmpegService.imageToVideoWithZoom(
        url_image,
        frame_rate,
        duration,
        requestId
      );

      const endTime = Date.now();
      const processingTime = endTime - startTime;

      // Generate public URL for the output video
      const outputFilename = basename(outputPath);
      const videoUrl = `${req.protocol}://${req.get('host')}/output/${outputFilename}`;

      const response: Img2VidResponse = {
        code: 200,
        message: 'Image to video conversion completed successfully',
        video_url: videoUrl,
        execution: {
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          durationMs: processingTime,
          durationSeconds: Math.round(processingTime / 1000 * 100) / 100
        },
        stats: {
          ...stats,
          inputImage: url_image,
          frameRate: frame_rate,
          videoDuration: duration,
          zoomFactor: '1.0 → 1.324'
        }
      };

      const logStats = {
        requestId,
        processingTimeMs: processingTime,
        processingTimeMin: (processingTime / 60000).toFixed(2),
        inputImageURL: url_image,
        frameRate: frame_rate,
        videoDuration: duration,
        outputVideoSizeMB: stats.outputVideoSize ? Math.round(stats.outputVideoSize / 1024 / 1024 * 100) / 100 : 'unknown',
        outputPath,
        videoUrl
      };

      logger.info('🎉 IMG2VID CONCLUÍDO COM SUCESSO!', logStats);

      res.json(response);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const processingTime = Date.now() - startTime;

      logger.error('💥 IMG2VID FALHOU', {
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
          message: 'Failed to download image file',
          requestId
        });
      } else if (errorMessage.includes('Image validation failed')) {
        res.status(422).json({
          error: 'Invalid image file',
          message: 'The provided image file is not valid',
          requestId
        });
      } else if (errorMessage.includes('FFmpeg failed')) {
        res.status(422).json({
          error: 'Video processing failed',
          message: 'Failed to process image to video conversion',
          requestId
        });
      } else if (errorMessage.includes('timeout') || errorMessage.includes('ECONNABORTED')) {
        res.status(504).json({
          error: 'Request timeout',
          message: 'Image to video conversion took too long to complete',
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
          error: 'Image to video conversion failed',
          message: errorMessage,
          requestId
        });
      }
    }
  }
);

// Health check endpoint for video services
router.get('/video/health', async (req: Request, res: Response) => {
  try {
    const healthCheck = await ffmpegService.healthCheck();
    const cleanupStatus = cleanupService.getCleanupStatus();

    res.json({
      service: 'Video Processing Service',
      status: healthCheck.ffmpegAvailable ? 'healthy' : 'unhealthy',
      ffmpeg: healthCheck,
      cleanup: cleanupStatus,
      endpoints: {
        caption: 'POST /video/caption',
        img2vid: 'POST /video/img2vid'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      service: 'Video Processing Service',
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// Manual cleanup endpoint
router.post('/video/cleanup', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    logger.info('🧹 Manual video cleanup requested', {
      ip: req.ip,
      userAgent: req.get('User-Agent')?.substring(0, 50) + '...'
    });

    await cleanupService.manualCleanup();

    res.json({
      success: true,
      message: 'Manual video cleanup completed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Manual video cleanup failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      ip: req.ip
    });

    res.status(500).json({
      success: false,
      error: 'Manual video cleanup failed',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// ENDPOINT 3: Add Audio to Video with Duration Sync
router.post('/video/adicionaAudio',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    const requestId = `addaudio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    try {
      const { error: validationError, value: requestData } = addAudioRequestSchema.validate(req.body);

      if (validationError) {
        logger.warn('Invalid add audio request parameters', {
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

      const { url_video, url_audio } = requestData as AddAudioRequest;

      logger.info('🚀 NOVA REQUISIÇÃO DE ADICIONAR ÁUDIO', {
        requestId,
        url_video,
        url_audio,
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

      logger.info('🎵 FASE 1: Iniciando processamento de adicionar áudio', {
        requestId,
        url_video,
        url_audio,
        phase: 'ADD_AUDIO_PROCESSING_START'
      });

      const { outputPath, stats } = await ffmpegService.addAudioToVideo(
        url_video,
        url_audio,
        requestId
      );

      const endTime = Date.now();
      const processingTime = endTime - startTime;

      // Generate public URL for the output video
      const outputFilename = basename(outputPath);
      const videoUrl = `${req.protocol}://${req.get('host')}/output/${outputFilename}`;

      const response: AddAudioResponse = {
        code: 200,
        message: 'Audio added to video successfully with duration sync',
        video_url: videoUrl,
        execution: {
          startTime: new Date(startTime).toISOString(),
          endTime: new Date(endTime).toISOString(),
          durationMs: processingTime,
          durationSeconds: Math.round(processingTime / 1000 * 100) / 100
        },
        stats: {
          ...stats,
          ffmpegCommand: `Video adjusted to match audio duration using setpts filter`
        }
      };

      const logStats = {
        requestId,
        processingTimeMs: processingTime,
        processingTimeMin: (processingTime / 60000).toFixed(2),
        inputVideoSizeMB: stats.inputVideoSize ? Math.round(stats.inputVideoSize / 1024 / 1024 * 100) / 100 : 'unknown',
        inputAudioSizeMB: stats.inputAudioSize ? Math.round(stats.inputAudioSize / 1024 / 1024 * 100) / 100 : 'unknown',
        outputVideoSizeMB: stats.outputVideoSize ? Math.round(stats.outputVideoSize / 1024 / 1024 * 100) / 100 : 'unknown',
        videoDuration: stats.videoDuration ? `${stats.videoDuration.toFixed(2)}s` : 'unknown',
        audioDuration: stats.audioDuration ? `${stats.audioDuration.toFixed(2)}s` : 'unknown',
        speedFactor: stats.speedFactor ? stats.speedFactor.toFixed(3) : 'unknown',
        timeAdjustment: stats.timeAdjustment,
        outputPath,
        videoUrl
      };

      logger.info('🎉 ADICIONAR ÁUDIO CONCLUÍDO COM SUCESSO!', logStats);

      res.json(response);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const processingTime = Date.now() - startTime;

      logger.error('💥 ADICIONAR ÁUDIO FALHOU', {
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
          message: 'Failed to download video or audio file',
          requestId
        });
      } else if (errorMessage.includes('Could not determine')) {
        res.status(422).json({
          error: 'Metadata extraction failed',
          message: 'Could not determine video or audio duration',
          requestId
        });
      } else if (errorMessage.includes('FFmpeg failed')) {
        res.status(422).json({
          error: 'Video processing failed',
          message: 'Failed to process video with audio',
          requestId
        });
      } else if (errorMessage.includes('timeout') || errorMessage.includes('ECONNABORTED')) {
        res.status(504).json({
          error: 'Request timeout',
          message: 'Audio addition took too long to complete',
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
          error: 'Add audio processing failed',
          message: errorMessage,
          requestId
        });
      }
    }
  }
);

export default router;