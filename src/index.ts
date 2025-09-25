import app from './app';
import { config } from './config/env';
import { logger } from './utils/logger';
import fs from 'fs';

const gracefulShutdown = (signal: string): void => {
  logger.info(`📴 Recebido ${signal} - Iniciando shutdown gracioso`, {
    signal,
    timestamp: new Date().toISOString(),
    uptime: `${process.uptime().toFixed(2)}s`
  });

  server.close((err) => {
    if (err) {
      logger.error('Error during server close', { error: err.message });
      process.exit(1);
    }

    logger.info('✅ Servidor fechado com sucesso', {
      uptime: `${process.uptime().toFixed(2)}s`,
      timestamp: new Date().toISOString()
    });

    setTimeout(() => {
      logger.warn('⚠️ Forçando shutdown por timeout (30s)');
      process.exit(1);
    }, 30000);

    process.exit(0);
  });
};

const server = app.listen(config.port, () => {
  logger.info('🚀 SERVIDOR INICIADO COM SUCESSO! 🚀', {
    service: 'API Transcrição',
    port: config.port,
    environment: config.nodeEnv,
    processId: process.pid,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    status: 'READY'
  });

  logger.info('⚙️ Configurações carregadas', {
    audio: {
      chunkTime: `${config.audio.chunkTime}s`,
      speedFactor: `${config.audio.speedFactor}x`,
      maxFileSize: `${config.audio.maxFileSizeMB}MB`,
      allowedFormats: config.audio.allowedFormats.join(', '),
      quality: `Level ${config.audio.quality}`
    },
    transcription: {
      maxRetries: config.transcription.maxRetries,
      concurrentChunks: config.transcription.concurrentChunks,
      timeout: `${config.transcription.requestTimeout / 1000}s`,
      model: config.openai.model
    },
    rateLimiting: {
      window: `${config.rateLimit.windowMs / 60000}min`,
      maxRequests: config.rateLimit.maxRequests
    }
  });

  logger.info('🌍 SERVIDOR PRONTO PARA CONEXÕES', {
    baseUrl: `http://localhost:${config.port}`,
    endpoints: {
      main: 'GET /',
      transcribe: 'POST /transcribe (requer Bearer token)',
      health: 'GET /health',
      status: 'GET /status/:jobId (requer Bearer token)'
    },
    documentation: {
      curl_example: `curl -X POST http://localhost:${config.port}/transcribe -H "Authorization: Bearer YOUR_API_KEY" -F "audio=@file.mp3"`,
      formats: 'json (default), srt, txt'
    },
    ready: true
  });
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('💥 EXCEÇÃO NÃO TRATADA - FINALIZANDO PROCESSO', {
    error: error.message,
    stack: error.stack,
    pid: process.pid,
    timestamp: new Date().toISOString()
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 REJEIÇÃO NÃO TRATADA - FINALIZANDO PROCESSO', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : 'N/A',
    promise: promise.toString(),
    pid: process.pid,
    timestamp: new Date().toISOString()
  });
  process.exit(1);
});

export default server;