import winston from 'winston';
import { config } from '../config/env';
import path from 'path';
import fs from 'fs';

if (!fs.existsSync(config.directories.logs)) {
  fs.mkdirSync(config.directories.logs, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.simple()
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