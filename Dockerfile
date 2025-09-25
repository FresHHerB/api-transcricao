# Build stage
FROM node:20-alpine AS build
WORKDIR /app

# Install system dependencies needed for build
RUN apk add --no-cache python3 make g++ ffmpeg

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and build
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS production
WORKDIR /app

# Install only system dependencies needed at runtime
RUN apk add --no-cache ffmpeg ca-certificates

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# Copy built application from build stage
COPY --from=build /app/dist ./dist

# Create directories for application
RUN mkdir -p temp output logs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => { process.exit(1); });"

# Start application
CMD ["node", "dist/index.js"]