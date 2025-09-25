import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config/env';
import { logger } from './utils/logger';
import transcriptionRoutes from './routes/transcription';
import fs from 'fs';
import path from 'path';

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(compression());

app.use(cors({
  origin: config.nodeEnv === 'development' ? '*' : false,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    error: 'Too many requests',
    message: `Rate limit exceeded. Maximum ${config.rateLimit.maxRequests} requests per ${config.rateLimit.windowMs / 60000} minutes.`
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.path === '/health';
  }
});

app.use(limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  logger.info('💬 Nova requisição', {
    requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.get('User-Agent')?.substring(0, 100) + '...',
    contentLength: req.get('Content-Length') || '0',
    timestamp: new Date().toISOString()
  });

  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusIcon = res.statusCode < 400 ? '✅' : res.statusCode < 500 ? '⚠️' : '❌';
    logger.info(`${statusIcon} Requisição finalizada`, {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      durationSec: (duration / 1000).toFixed(2),
      contentLength: res.get('Content-Length') || '0',
      success: res.statusCode < 400
    });
  });

  next();
});

if (!fs.existsSync(config.directories.temp)) {
  fs.mkdirSync(config.directories.temp, { recursive: true });
}
if (!fs.existsSync(config.directories.output)) {
  fs.mkdirSync(config.directories.output, { recursive: true });
}
if (!fs.existsSync(config.directories.logs)) {
  fs.mkdirSync(config.directories.logs, { recursive: true });
}

app.use('/', transcriptionRoutes);

app.get('/', (req, res) => {
  res.json({
    service: 'API Transcricao',
    version: '1.0.0',
    status: 'operational',
    timestamp: new Date().toISOString(),
    endpoints: {
      transcribe: 'POST /transcribe',
      health: 'GET /health',
      status: 'GET /status/:jobId'
    },
    documentation: {
      transcribe: {
        method: 'POST',
        path: '/transcribe',
        headers: {
          'Authorization': 'Bearer YOUR_API_KEY',
          'Content-Type': 'multipart/form-data'
        },
        body: {
          audio: 'Audio file (mp3, wav, m4a, ogg, flac, aac)',
          speed: 'Optional: Processing speed factor (1-3, default: 2)',
          format: 'Optional: Output format (json, srt, txt, default: json)'
        }
      }
    }
  });
});

app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    availableEndpoints: [
      'POST /transcribe',
      'GET /health',
      'GET /status/:jobId',
      'GET /'
    ]
  });
});

app.use((error: any, req: any, res: any, next: any) => {
  const errorId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  logger.error('Unhandled error', {
    errorId,
    error: error.message,
    stack: error.stack,
    method: req.method,
    path: req.path,
    ip: req.ip
  });

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: 'Internal Server Error',
    message: config.nodeEnv === 'development' ? error.message : 'An unexpected error occurred',
    errorId
  });
});

export default app;