import * as Joi from 'joi';
import * as dotenv from 'dotenv';

dotenv.config();

const envSchema = Joi.object({
  // Server Configuration
  PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),

  // API Keys (Required)
  X_API_KEY: Joi.string().required(),
  OPENAI_API_KEY: Joi.string().required(),

  // Audio Processing
  CHUNK_TIME: Joi.number().default(900),
  SPEED_FACTOR: Joi.number().default(2.0),
  AUDIO_QUALITY: Joi.number().default(3),
  MAX_FILE_SIZE_MB: Joi.number().default(500),
  ALLOWED_AUDIO_FORMATS: Joi.string().default('mp3,wav,m4a,ogg,flac,aac'),

  // Directories
  TEMP_DIR: Joi.string().default('./temp'),
  OUTPUT_DIR: Joi.string().default('./output'),
  LOGS_DIR: Joi.string().default('./logs'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: Joi.number().default(900000),
  RATE_LIMIT_MAX_REQUESTS: Joi.number().default(10),

  // Transcription Configuration
  MAX_RETRIES: Joi.number().default(5),
  INITIAL_RETRY_DELAY: Joi.number().default(1000),
  CONCURRENT_CHUNKS: Joi.number().default(4),
  REQUEST_TIMEOUT: Joi.number().default(600000),

  // CORS Configuration
  CORS_ALLOW_ORIGINS: Joi.string().default('*'),

  // Logging
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),

  // Cleanup
  AUTO_CLEANUP_TEMP_FILES: Joi.boolean().default(true),
  TEMP_FILE_MAX_AGE_HOURS: Joi.number().default(24)
}).unknown();

const { error, value: envVars } = envSchema.validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

export const config = {
  // Server Configuration
  port: envVars.PORT,
  nodeEnv: envVars.NODE_ENV,
  apiKey: envVars.X_API_KEY,

  // OpenAI Configuration
  openai: {
    apiKey: envVars.OPENAI_API_KEY,
    model: 'whisper-1' as const
  },

  // Audio Processing
  audio: {
    chunkTime: envVars.CHUNK_TIME,
    speedFactor: envVars.SPEED_FACTOR,
    quality: envVars.AUDIO_QUALITY,
    maxFileSizeMB: envVars.MAX_FILE_SIZE_MB,
    allowedFormats: envVars.ALLOWED_AUDIO_FORMATS.split(',').map((f: string) => f.trim())
  },

  // Directories
  directories: {
    temp: envVars.TEMP_DIR,
    output: envVars.OUTPUT_DIR,
    logs: envVars.LOGS_DIR
  },

  // Rate Limiting
  rateLimit: {
    windowMs: envVars.RATE_LIMIT_WINDOW_MS,
    maxRequests: envVars.RATE_LIMIT_MAX_REQUESTS
  },

  // Transcription Configuration
  transcription: {
    maxRetries: envVars.MAX_RETRIES,
    initialRetryDelay: envVars.INITIAL_RETRY_DELAY,
    concurrentChunks: envVars.CONCURRENT_CHUNKS,
    requestTimeout: envVars.REQUEST_TIMEOUT
  },

  // CORS Configuration
  cors: {
    allowOrigins: envVars.CORS_ALLOW_ORIGINS
  },

  // Logging Configuration
  logging: {
    level: envVars.LOG_LEVEL
  },

  // Cleanup Configuration
  cleanup: {
    autoCleanupTempFiles: envVars.AUTO_CLEANUP_TEMP_FILES,
    tempFileMaxAgeHours: envVars.TEMP_FILE_MAX_AGE_HOURS
  }
} as const;