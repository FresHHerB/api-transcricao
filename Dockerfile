# Build stage - compile TypeScript
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci --no-audit --prefer-offline

# Copy source code
COPY src ./src

# Build the application
RUN npm run build && \
    ls -la dist/ && \
    echo "Build completed successfully"

# Production stage - optimized runtime
FROM node:18-alpine AS production

# Install system dependencies
RUN apk add --no-cache \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production --no-audit --prefer-offline && \
    npm cache clean --force && \
    rm -rf ~/.npm

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Verify the build was copied correctly
RUN ls -la dist/ && \
    test -f dist/index.js || (echo "ERROR: dist/index.js not found" && exit 1)

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create required directories with proper permissions
RUN mkdir -p /app/temp /app/output /app/logs && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose application port
EXPOSE 3000

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => { process.exit(1); });"

# Start the application
CMD ["node", "dist/index.js"]