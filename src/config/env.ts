import * as Joi from 'joi';
import * as dotenv from 'dotenv';

dotenv.config();

const envSchema = Joi.object({
  PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  X_API_KEY: Joi.string().required(),
  OPENAI_API_KEY: Joi.string().required(),
  CHUNK_TIME: Joi.number().default(900),
  SPEED_FACTOR: Joi.number().default(2.0),
  AUDIO_QUALITY: Joi.number().default(3),
  TEMP_DIR: Joi.string().default('./temp'),
  OUTPUT_DIR: Joi.string().default('./output'),
  LOGS_DIR: Joi.string().default('./logs'),
  RATE_LIMIT_WINDOW_MS: Joi.number().default(900000),
  RATE_LIMIT_MAX_REQUESTS: Joi.number().default(10),
  MAX_RETRIES: Joi.number().default(5),
  INITIAL_RETRY_DELAY: Joi.number().default(1000),
  CONCURRENT_CHUNKS: Joi.number().default(4),
  REQUEST_TIMEOUT: Joi.number().default(600000),
  MAX_FILE_SIZE_MB: Joi.number().default(500),
  ALLOWED_AUDIO_FORMATS: Joi.string().default('mp3,wav,m4a,ogg,flac,aac')
}).unknown();

const { error, value: envVars } = envSchema.validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

export const config = {
  port: envVars.PORT,
  nodeEnv: envVars.NODE_ENV,
  apiKey: envVars.X_API_KEY,
  openai: {
    apiKey: envVars.OPENAI_API_KEY,
    model: 'whisper-1' as const
  },
  audio: {
    chunkTime: envVars.CHUNK_TIME,
    speedFactor: envVars.SPEED_FACTOR,
    quality: envVars.AUDIO_QUALITY,
    maxFileSizeMB: envVars.MAX_FILE_SIZE_MB,
    allowedFormats: envVars.ALLOWED_AUDIO_FORMATS.split(',').map((f: string) => f.trim())
  },
  directories: {
    temp: envVars.TEMP_DIR,
    output: envVars.OUTPUT_DIR,
    logs: envVars.LOGS_DIR
  },
  rateLimit: {
    windowMs: envVars.RATE_LIMIT_WINDOW_MS,
    maxRequests: envVars.RATE_LIMIT_MAX_REQUESTS
  },
  transcription: {
    maxRetries: envVars.MAX_RETRIES,
    initialRetryDelay: envVars.INITIAL_RETRY_DELAY,
    concurrentChunks: envVars.CONCURRENT_CHUNKS,
    requestTimeout: envVars.REQUEST_TIMEOUT
  }
} as const;