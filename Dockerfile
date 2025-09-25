# Build stage
FROM node:20-slim AS build

# Set environment variables for build
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=development

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

# Environment variables
ENV NODE_ENV=production \
    PORT=3000

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