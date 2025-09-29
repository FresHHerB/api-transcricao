import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config/env';
import { logger } from './utils/logger';
import transcriptionRoutes from './routes/transcription';
import imageGenerationRoutes from './routes/imageGeneration';
import videoRoutes from './routes/video';
import fs from 'fs';
import path from 'path';

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(compression());

// CORS configurável via environment
const allowedOrigins = process.env.CORS_ALLOW_ORIGINS || '*';
const corsOrigins = allowedOrigins === '*' ? true : allowedOrigins.split(',').map(origin => origin.trim());

app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

// Rate limiting disabled as per requirements
// const limiter = rateLimit({
//   windowMs: config.rateLimit.windowMs,
//   max: config.rateLimit.maxRequests,
//   message: {
//     error: 'Too many requests',
//     message: `Rate limit exceeded. Maximum ${config.rateLimit.maxRequests} requests per ${config.rateLimit.windowMs / 60000} minutes.`
//   },
//   standardHeaders: true,
//   legacyHeaders: false,
//   skip: (req) => {
//     return req.path === '/health' || req.path === '/gerarPrompts' || req.path === '/gerarImagens';
//   }
// });

// app.use(limiter);

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.use((req, res, next) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  logger.info(`💬 ${req.method} ${req.path} - ${req.ip}`, {
    requestId,
    userAgent: req.get('User-Agent')?.substring(0, 50) + '...',
    contentLength: req.get('Content-Length') || '0'
  });

  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusIcon = res.statusCode < 400 ? '✅' : res.statusCode < 500 ? '⚠️' : '❌';
    const status = res.statusCode < 400 ? 'SUCCESS' : res.statusCode < 500 ? 'WARNING' : 'ERROR';

    logger.info(`${statusIcon} ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`, {
      requestId,
      status,
      duration: `${duration}ms`
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

// Serve static files from output directory
app.use('/output', express.static(config.directories.output, {
  maxAge: '24h', // Cache for 24 hours
  setHeaders: (res, path) => {
    // Set appropriate headers for different file types
    if (path.endsWith('.srt')) {
      res.setHeader('Content-Type', 'text/srt; charset=utf-8');
    } else if (path.endsWith('.txt')) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    } else if (path.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }

    // Add download headers
    const filename = path.split('/').pop() || 'file';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
}));

app.use('/', transcriptionRoutes);
app.use('/', imageGenerationRoutes);
app.use('/', videoRoutes);

app.get('/', (req, res) => {
  res.json({
    service: 'API Transcricao',
    version: '1.0.0',
    status: 'operational',
    timestamp: new Date().toISOString(),
    endpoints: {
      transcribe: 'POST /transcribe',
      gerarPrompts: 'POST /gerarPrompts',
      gerarImagens: 'POST /gerarImagens',
      videoCaption: 'POST /video/caption',
      videoImg2Vid: 'POST /video/img2vid',
      health: 'GET /health',
      videoHealth: 'GET /video/health',
      status: 'GET /status/:jobId',
      files: 'GET /output/:jobId/:filename'
    },
    documentation: {
      transcribe: {
        method: 'POST',
        path: '/transcribe',
        headers: {
          'X-API-Key': 'YOUR_API_KEY',
          'Content-Type': 'multipart/form-data'
        },
        body: {
          audio: 'Audio file (mp3, wav, m4a, ogg, flac, aac)',
          speed: 'Optional: Processing speed factor (1-3, default: 2)',
          format: 'Optional: Output format (json, srt, txt, default: json)'
        }
      },
      gerarPrompts: {
        method: 'POST',
        path: '/gerarPrompts',
        headers: {
          'X-API-Key': 'YOUR_API_KEY',
          'Content-Type': 'application/json'
        },
        body: {
          cenas: 'Array of scenes with index and texto',
          estilo: 'Visual style description',
          detalhe_estilo: 'Detailed style specifications',
          roteiro: 'Full script/scenario',
          agente: 'System prompt for prompt generation'
        }
      },
      gerarImagens: {
        method: 'POST',
        path: '/gerarImagens',
        headers: {
          'X-API-Key': 'YOUR_API_KEY',
          'Content-Type': 'application/json'
        },
        body: {
          prompts: 'Array of prompts with index and prompt text',
          image_model: 'Runware model ID for image generation',
          altura: 'Image height (512-2048)',
          largura: 'Image width (512-2048)'
        }
      },
      videoCaption: {
        method: 'POST',
        path: '/video/caption',
        headers: {
          'X-API-Key': 'YOUR_API_KEY',
          'Content-Type': 'application/json'
        },
        body: {
          url_video: 'URL of the video file to add captions to',
          url_srt: 'URL of the SRT subtitle file'
        }
      },
      videoImg2Vid: {
        method: 'POST',
        path: '/video/img2vid',
        headers: {
          'X-API-Key': 'YOUR_API_KEY',
          'Content-Type': 'application/json'
        },
        body: {
          url_image: 'URL of the image file to convert to video',
          frame_rate: 'Video frame rate (1-60, default: 24)',
          duration: 'Video duration in seconds (0.1-60)'
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
      'POST /gerarPrompts',
      'POST /gerarImagens',
      'POST /video/caption',
      'POST /video/img2vid',
      'GET /health',
      'GET /video/health',
      'GET /status/:jobId',
      'GET /output/:jobId/:filename',
      'GET /'
    ]
  });
});

app.use((error: any, req: any, res: any, next: any) => {
  const errorId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  logger.error(`💥 Erro interno - ${req.method} ${req.path} - ${req.ip} - ID: ${errorId}`, {
    error: error.message,
    stack: error.stack
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