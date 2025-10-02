import winston from 'winston';
import { config } from '../config/env';
import path from 'path';
import fs from 'fs';

if (!fs.existsSync(config.directories.logs)) {
  fs.mkdirSync(config.directories.logs, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'HH:mm:ss'
  }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, service, jobId, phase, ...meta }) => {
    const messageStr = String(message);
    let baseLog = `${timestamp}`;

    // Add job indicator for better tracking
    if (jobId) {
      const shortJobId = String(jobId).substring(0, 8);
      baseLog += ` [${shortJobId}]`;
    }

    // Add phase for better flow tracking
    if (phase) {
      baseLog += ` {${phase}}`;
    }

    baseLog += ` ${level} ${messageStr}`;

    // Show metadata only for important logs or when specifically needed
    const shouldShowMeta = Object.keys(meta).length > 0 && (
      messageStr.includes('INICIANDO') ||
      messageStr.includes('CONCLUÍDO') ||
      messageStr.includes('FALHOU') ||
      messageStr.includes('chunks') ||
      messageStr.includes('processamento') ||
      messageStr.includes('CPU Monitor') ||
      messageStr.includes('CPU State') ||
      messageStr.includes('Starting FFmpeg') ||
      messageStr.includes('Starting image') ||
      level.includes('error') ||
      level.includes('warn')
    );

    if (shouldShowMeta) {
      // Format metadata more cleanly
      const cleanMeta = Object.fromEntries(
        Object.entries(meta).filter(([key]) => !['service', 'timestamp'].includes(key))
      );
      if (Object.keys(cleanMeta).length > 0) {
        baseLog += `\n    ${JSON.stringify(cleanMeta, null, 2).replace(/\n/g, '\n    ')}`;
      }
    }

    return baseLog;
  })
);

export const logger = winston.createLogger({
  level: config.nodeEnv === 'development' ? 'debug' : 'info',
  format: logFormat,
  defaultMeta: { service: 'api-transcricao' },
  transports: [
    new winston.transports.File({
      filename: path.join(config.directories.logs, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 10
    }),
    new winston.transports.File({
      filename: path.join(config.directories.logs, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 10
    }),
    new winston.transports.Console({
      format: consoleFormat,
      level: config.nodeEnv === 'development' ? 'debug' : 'info'
    })
  ]
});

export const createJobLogger = (jobId: string): winston.Logger => {
  const jobLogPath = path.join(config.directories.logs, `job-${jobId}.log`);

  return winston.createLogger({
    level: 'debug',
    format: logFormat,
    defaultMeta: { jobId },
    transports: [
      new winston.transports.File({
        filename: jobLogPath,
        maxsize: 10485760, // 10MB
        maxFiles: 1
      }),
      new winston.transports.Console({
        format: consoleFormat,
        level: 'info'
      })
    ]
  });
};