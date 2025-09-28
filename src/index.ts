import app from './app';
import { config } from './config/env';
import { logger } from './utils/logger';
import fs from 'fs';

const gracefulShutdown = (signal: string): void => {
  logger.info(`📴 Shutdown gracioso iniciado - Signal: ${signal} - Uptime: ${process.uptime().toFixed(2)}s`);

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

const server = app.listen(config.port, () => {
  logger.info(`🚀 API Transcrição iniciada - Port:${config.port} Env:${config.nodeEnv} PID:${process.pid}`);

  logger.info(`⚙️ Audio: ${config.audio.maxFileSizeMB}MB max, ${config.audio.speedFactor}x speed - apenas aceleração`);

  logger.info(`⚙️ Whisper: Model ${config.openai.model}, ${config.transcription.concurrentChunks} chunks, ${config.transcription.maxRetries} retries`);

  logger.info(`⚙️ Rate Limit: ${config.rateLimit.maxRequests} req/${config.rateLimit.windowMs / 60000}min`);

  logger.info(`🌍 Servidor pronto em http://localhost:${config.port} - Endpoints: POST /generateImage, POST /transcribe, GET /health, GET /status/:jobId`);
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
