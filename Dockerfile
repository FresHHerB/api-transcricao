# Build stage
FROM node:20-slim AS build

# Declare all build arguments
ARG PORT
ARG NODE_ENV
ARG X_API_KEY
ARG OPENAI_API_KEY
ARG OPENROUTER_API_KEY
ARG RUNWARE_API_KEY
ARG CHUNK_TIME
ARG SPEED_FACTOR
ARG MAX_FILE_SIZE_MB
ARG ALLOWED_AUDIO_FORMATS
ARG TEMP_DIR
ARG OUTPUT_DIR
ARG LOGS_DIR
ARG RATE_LIMIT_WINDOW_MS
ARG RATE_LIMIT_MAX_REQUESTS
ARG MAX_RETRIES
ARG INITIAL_RETRY_DELAY
ARG CONCURRENT_CHUNKS
ARG REQUEST_TIMEOUT
ARG CORS_ALLOW_ORIGINS
ARG LOG_LEVEL
ARG AUTO_CLEANUP_TEMP_FILES
ARG TEMP_FILE_MAX_AGE_HOURS
ARG OPENROUTER_MODEL
ARG IMAGE_GENERATION_TIMEOUT
ARG MAX_CONCURRENT_IMAGES
ARG BATCH_SIZE_IMAGES
ARG GIT_SHA

# Set environment variables for build
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=${NODE_ENV:-development} \
    PORT=${PORT:-3000} \
    X_API_KEY=${X_API_KEY} \
    OPENAI_API_KEY=${OPENAI_API_KEY} \
    OPENROUTER_API_KEY=${OPENROUTER_API_KEY} \
    RUNWARE_API_KEY=${RUNWARE_API_KEY} \
    CHUNK_TIME=${CHUNK_TIME} \
    SPEED_FACTOR=${SPEED_FACTOR} \
    MAX_FILE_SIZE_MB=${MAX_FILE_SIZE_MB} \
    ALLOWED_AUDIO_FORMATS=${ALLOWED_AUDIO_FORMATS} \
    TEMP_DIR=${TEMP_DIR} \
    OUTPUT_DIR=${OUTPUT_DIR} \
    LOGS_DIR=${LOGS_DIR} \
    RATE_LIMIT_WINDOW_MS=${RATE_LIMIT_WINDOW_MS} \
    RATE_LIMIT_MAX_REQUESTS=${RATE_LIMIT_MAX_REQUESTS} \
    MAX_RETRIES=${MAX_RETRIES} \
    INITIAL_RETRY_DELAY=${INITIAL_RETRY_DELAY} \
    CONCURRENT_CHUNKS=${CONCURRENT_CHUNKS} \
    REQUEST_TIMEOUT=${REQUEST_TIMEOUT} \
    CORS_ALLOW_ORIGINS=${CORS_ALLOW_ORIGINS} \
    LOG_LEVEL=${LOG_LEVEL} \
    AUTO_CLEANUP_TEMP_FILES=${AUTO_CLEANUP_TEMP_FILES} \
    TEMP_FILE_MAX_AGE_HOURS=${TEMP_FILE_MAX_AGE_HOURS} \
    OPENROUTER_MODEL=${OPENROUTER_MODEL} \
    IMAGE_GENERATION_TIMEOUT=${IMAGE_GENERATION_TIMEOUT} \
    MAX_CONCURRENT_IMAGES=${MAX_CONCURRENT_IMAGES} \
    BATCH_SIZE_IMAGES=${BATCH_SIZE_IMAGES}

WORKDIR /app

# Install system dependencies needed for build
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm ci --verbose

# Copy source code and build
COPY . .
RUN npm run build && \
    ls -la dist/ && \
    echo "Build completed successfully"

# Production stage
FROM node:20-slim AS production

# Declare all build arguments for production runtime
ARG PORT=3000
ARG NODE_ENV=production
ARG X_API_KEY
ARG OPENAI_API_KEY
ARG OPENROUTER_API_KEY
ARG RUNWARE_API_KEY
ARG CHUNK_TIME=900
ARG SPEED_FACTOR=1.5
ARG MAX_FILE_SIZE_MB=500
ARG ALLOWED_AUDIO_FORMATS=mp3,wav,m4a,ogg,flac,aac
ARG TEMP_DIR=./temp
ARG OUTPUT_DIR=./output
ARG LOGS_DIR=./logs
ARG RATE_LIMIT_WINDOW_MS=900000
ARG RATE_LIMIT_MAX_REQUESTS=10
ARG MAX_RETRIES=5
ARG INITIAL_RETRY_DELAY=1000
ARG CONCURRENT_CHUNKS=4
ARG REQUEST_TIMEOUT=600000
ARG CORS_ALLOW_ORIGINS=*
ARG LOG_LEVEL=info
ARG AUTO_CLEANUP_TEMP_FILES=true
ARG TEMP_FILE_MAX_AGE_HOURS=24
ARG OPENROUTER_MODEL=google/gemini-2.5-flash
ARG IMAGE_GENERATION_TIMEOUT=120000
ARG MAX_CONCURRENT_IMAGES=3
ARG BATCH_SIZE_IMAGES=10

# Set environment variables for runtime
ENV NODE_ENV=${NODE_ENV} \
    PORT=${PORT} \
    X_API_KEY=${X_API_KEY} \
    OPENAI_API_KEY=${OPENAI_API_KEY} \
    OPENROUTER_API_KEY=${OPENROUTER_API_KEY} \
    RUNWARE_API_KEY=${RUNWARE_API_KEY} \
    CHUNK_TIME=${CHUNK_TIME} \
    SPEED_FACTOR=${SPEED_FACTOR} \
    MAX_FILE_SIZE_MB=${MAX_FILE_SIZE_MB} \
    ALLOWED_AUDIO_FORMATS=${ALLOWED_AUDIO_FORMATS} \
    TEMP_DIR=${TEMP_DIR} \
    OUTPUT_DIR=${OUTPUT_DIR} \
    LOGS_DIR=${LOGS_DIR} \
    RATE_LIMIT_WINDOW_MS=${RATE_LIMIT_WINDOW_MS} \
    RATE_LIMIT_MAX_REQUESTS=${RATE_LIMIT_MAX_REQUESTS} \
    MAX_RETRIES=${MAX_RETRIES} \
    INITIAL_RETRY_DELAY=${INITIAL_RETRY_DELAY} \
    CONCURRENT_CHUNKS=${CONCURRENT_CHUNKS} \
    REQUEST_TIMEOUT=${REQUEST_TIMEOUT} \
    CORS_ALLOW_ORIGINS=${CORS_ALLOW_ORIGINS} \
    LOG_LEVEL=${LOG_LEVEL} \
    AUTO_CLEANUP_TEMP_FILES=${AUTO_CLEANUP_TEMP_FILES} \
    TEMP_FILE_MAX_AGE_HOURS=${TEMP_FILE_MAX_AGE_HOURS} \
    OPENROUTER_MODEL=${OPENROUTER_MODEL} \
    IMAGE_GENERATION_TIMEOUT=${IMAGE_GENERATION_TIMEOUT} \
    MAX_CONCURRENT_IMAGES=${MAX_CONCURRENT_IMAGES} \
    BATCH_SIZE_IMAGES=${BATCH_SIZE_IMAGES}

WORKDIR /app

# Install only runtime system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production --no-audit && \
    npm cache clean --force

# Copy built application from build stage
COPY --from=build /app/dist ./dist

# Create directories and set permissions
RUN mkdir -p temp output logs && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Enhanced health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Start application
CMD ["node", "dist/index.js"]