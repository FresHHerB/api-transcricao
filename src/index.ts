import app from './app';
import { config } from './config/env';
import { logger } from './utils/logger';
import { cleanupService } from './services/cleanupService';
import fs from 'fs';

const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info(`📴 Shutdown gracioso iniciado - Signal: ${signal} - Uptime: ${process.uptime().toFixed(2)}s`);

  // Stop cleanup service
  cleanupService.stopCleanupScheduler();

  server.close((err) => {
    if (err) {
      logger.error(`❌ Erro ao fechar servidor: ${err.message}`);
      process.exit(1);
    }

    logger.info(`✅ Servidor fechado com sucesso - Uptime: ${process.uptime().toFixed(2)}s`);

    setTimeout(() => {
      logger.warn('⚠️ Forçando shutdown por timeout (30s)');
      process.exit(1);
    }, 30000);

    process.exit(0);
  });
};

const server = app.listen(config.port, '0.0.0.0', async () => {
  logger.info(`🚀 API Transcrição iniciada - Port:${config.port} Env:${config.nodeEnv} PID:${process.pid}`);

  logger.info(`⚙️ Audio: ${config.audio.maxFileSizeMB}MB max, ${config.audio.speedFactor}x speed - apenas aceleração`);

  logger.info(`⚙️ Whisper: Model ${config.openai.model}, ${config.transcription.concurrentChunks} chunks, ${config.transcription.maxRetries} retries`);

  logger.info(`⚙️ Rate Limit: ${config.rateLimit.maxRequests} req/${config.rateLimit.windowMs / 60000}min`);

  logger.info(`🌍 Servidor LOCAL em http://0.0.0.0:${config.port}`);
  logger.info(`📡 Endpoints: POST /gerarPrompts, POST /gerarImagens, POST /transcribe, POST /video/caption, POST /video/img2vid, GET /health, GET /status/:jobId`);

  // Log cleanup service status
  const cleanupStatus = cleanupService.getCleanupStatus();
  logger.info(`🧹 Cleanup Service: ${cleanupStatus.isRunning ? 'Ativo' : 'Inativo'} - Max Age: ${cleanupStatus.maxAgeHours}h - Interval: ${cleanupStatus.intervalHours}h`);
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error(`💥 Exceção não tratada - PID:${process.pid} - ${error.message}`);
  logger.debug('Stack trace:', { stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  const errorMsg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`💥 Promise rejeitada - PID:${process.pid} - ${errorMsg}`);
  logger.debug('Promise details:', {
    stack: reason instanceof Error ? reason.stack : 'N/A',
    promise: promise.toString()
  });
  process.exit(1);
});

export default server;
