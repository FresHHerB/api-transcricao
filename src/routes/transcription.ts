import { Router, Request, Response } from 'express';
import { TranscriptionService } from '../services/transcriptionService';
import { OutputFormatter } from '../services/outputFormatter';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { uploadMiddleware, handleUploadError, validateAudioFile } from '../middleware/upload';
import { logger } from '../utils/logger';
import { OutputFormat, TranscribeRequest } from '../types';
import { config } from '../config/env';
import fs from 'fs';
import path from 'path';
import Joi from 'joi';

const router = Router();
const transcriptionService = new TranscriptionService();

const transcribeRequestSchema = Joi.object({
  speed: Joi.number().min(1).max(3).optional(),
  format: Joi.string().valid('json', 'srt', 'txt').optional().default('json')
});

router.post('/transcribe',
  authenticateToken,
  uploadMiddleware,
  handleUploadError,
  async (req: AuthenticatedRequest, res: Response) => {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      if (!req.file) {
        res.status(400).json({
          error: 'No file uploaded',
          message: 'Please upload an audio file in the "audio" field'
        });
        return;
      }

      const { error: validationError, value: requestData } = transcribeRequestSchema.validate({
        speed: req.body.speed ? parseFloat(req.body.speed) : undefined,
        format: req.body.format || 'json'
      } as TranscribeRequest);

      if (validationError) {
        logger.warn('Invalid request parameters', {
          requestId,
          error: validationError.message,
          body: req.body
        });

        res.status(400).json({
          error: 'Invalid parameters',
          message: validationError.message
        });
        return;
      }

      const { speed, format } = requestData as Required<TranscribeRequest>;

      // Validar arquivo de áudio antes do processamento
      try {
        const audioValidation = await validateAudioFile(req.file.path);

        if (audioValidation.suspicious) {
          logger.warn('🚨 ARQUIVO SUSPEITO DETECTADO', {
            requestId,
            fileName: req.file.originalname,
            warning: audioValidation.warning,
            durationMinutes: (audioValidation.duration / 60).toFixed(1),
            recommendation: 'Verificar com cliente se arquivo está correto'
          });
        }
      } catch (error) {
        logger.warn('⚠️ Falha na validação de áudio, continuando...', {
          requestId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }

      logger.info('🚀 NOVA REQUISIÇÃO DE TRANSCRIÇÃO', {
        requestId,
        fileName: req.file.originalname,
        fileSize: `${(req.file.size / (1024 * 1024)).toFixed(2)}MB`,
        speed: speed || config.audio.speedFactor,
        format,
        ip: req.ip,
        userAgent: req.get('User-Agent')?.substring(0, 50) + '...',
        timestamp: new Date().toISOString()
      });

      const startTime = Date.now();

      try {
        const result = await transcriptionService.transcribeAudio(
          req.file.path,
          speed,
          format
        );

        const processingTime = Date.now() - startTime;

        const stats = {
          requestId,
          jobId: result.job.id,
          processingTimeMs: processingTime,
          processingTimeMin: (processingTime / 60000).toFixed(2),
          segments: result.transcript.segments.length,
          characters: result.transcript.fullText.length,
          words: result.transcript.fullText.split(' ').length,
          status: result.job.status,
          efficiency: `${((result.job.sourceDurationS || 0) / (processingTime / 1000)).toFixed(2)}x real-time`,
          chunksProcessed: result.job.processedChunks,
          totalChunks: result.job.processedChunks + result.job.failedChunks.length
        };

        logger.info('🎆 TRANSCRIÇÃO CONCLUÍDA COM SUCESSO!', stats);

        if (result.warnings && result.warnings.length > 0) {
          logger.warn('⚠️ Avisos na transcrição', {
            requestId,
            jobId: result.job.id,
            warnings: result.warnings
          });
        }

        if (format === 'json') {
          res.json(result);
        } else if (format === 'srt' && result.transcript.formats?.srtPath) {
          const outputFormatter = new OutputFormatter(result.job.id);
          const srtContent = outputFormatter.readSRTFile(result.transcript.formats.srtPath);

          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="transcript.srt"`);
          res.send(srtContent);
        } else if (format === 'txt' && result.transcript.formats?.txtPath) {
          const outputFormatter = new OutputFormatter(result.job.id);
          const txtContent = outputFormatter.readTXTFile(result.transcript.formats.txtPath);

          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="transcript.txt"`);
          res.send(txtContent);
        } else {
          res.json(result);
        }

      } catch (transcriptionError) {
        const errorMessage = transcriptionError instanceof Error
          ? transcriptionError.message
          : 'Unknown transcription error';

        logger.error('💥 TRANSCRIÇÃO FALHOU', {
          requestId,
          error: errorMessage,
          fileName: req.file.originalname,
          fileSize: `${(req.file.size / (1024 * 1024)).toFixed(2)}MB`,
          processingTimeMs: Date.now() - startTime,
          processingTimeMin: ((Date.now() - startTime) / 60000).toFixed(2),
          ip: req.ip,
          timestamp: new Date().toISOString()
        });

        res.status(500).json({
          error: 'Transcription failed',
          message: errorMessage,
          requestId
        });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('Request processing failed', {
        requestId,
        error: errorMessage,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Internal server error',
        message: errorMessage,
        requestId
      });
    } finally {
      if (req.file && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
          logger.info('🧹 Arquivo de upload limpo', {
            requestId,
            fileName: path.basename(req.file.path),
            phase: 'Upload cleanup completed'
          });
        } catch (cleanupError) {
          logger.warn('Failed to cleanup uploaded file', {
            requestId,
            filePath: req.file.path,
            error: cleanupError instanceof Error ? cleanupError.message : 'Unknown error'
          });
        }
      }
    }
  }
);

router.get('/health',
  (req: Request, res: Response) => {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      environment: config.nodeEnv,
      memory: process.memoryUsage()
    };

    res.json(health);
  }
);

router.get('/status/:jobId',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { jobId } = req.params;

      if (!jobId || typeof jobId !== 'string') {
        res.status(400).json({
          error: 'Invalid job ID',
          message: 'Job ID must be a valid string'
        });
        return;
      }

      const status = await transcriptionService.getJobStatus(jobId);

      res.json({
        jobId,
        exists: status.exists,
        completed: status.completed,
        status: status.completed ? 'completed' : status.exists ? 'processing' : 'not_found'
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('Status check failed', {
        jobId: req.params.jobId,
        error: errorMessage
      });

      res.status(500).json({
        error: 'Status check failed',
        message: errorMessage
      });
    }
  }
);

export default router;