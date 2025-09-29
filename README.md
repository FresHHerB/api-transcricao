# API Transcrição

A comprehensive API for audio transcription, AI-powered image generation, and video captioning. Built for production deployment with robust processing pipelines and high-performance capabilities.

## Features

### 🎤 **Audio Transcription**
- **High-Performance Processing**: 2x speed acceleration with FFmpeg
- **Smart Chunking**: Asynchronous 15-minute chunks for optimal performance
- **Multiple Formats**: JSON, SRT, and TXT output formats
- **Robust Error Handling**: Exponential backoff retry mechanism

### 🎨 **AI Image Generation**
- **Two-Stage Pipeline**: Separate prompt generation and image creation
- **OpenRouter Integration**: AI-powered prompt enhancement
- **Runware WebSocket**: High-quality image generation
- **Batch Processing**: Efficient concurrent image generation

### 🎬 **Video Captioning**
- **FFmpeg Integration**: Professional video processing
- **SRT Subtitle Support**: Standard subtitle format integration
- **Quality Control**: Automatic video validation and optimization

### 🔧 **Core Features**
- **Authentication**: Secure API key-based authentication
- **Rate Limiting**: Configurable request throttling
- **Health Monitoring**: Comprehensive health checks
- **Docker Ready**: Full containerization support
- **Auto Cleanup**: Automatic temporary file management

## Quick Start

### Prerequisites

- Node.js 18+
- FFmpeg
- OpenAI API Key
- OpenRouter API Key
- Runware API Key

### Installation

1. Clone and install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env with your API keys and configuration
```

3. Build and start:
```bash
npm run build
npm start
```

### Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# Or build manually
docker build -t api-transcricao .
docker run -p 3000:3000 --env-file .env api-transcricao
```

## API Endpoints

### 🎤 Audio Transcription

**POST** `/transcribe`

**Headers:**
- `X-API-Key: YOUR_API_KEY`
- `Content-Type: multipart/form-data`

**Body:**
- `audio` (file): Audio file (mp3, wav, m4a, ogg, flac, aac)
- `speed` (optional): Processing speed factor (1-3, default: 2)
- `format` (optional): Output format (json, srt, txt, default: json)

**Example:**
```bash
curl -X POST http://localhost:3334/transcribe \
  -H "X-API-Key: YOUR_API_KEY" \
  -F "audio=@audio.mp3" \
  -F "speed=2" \
  -F "format=json"
```

### 🎨 AI Image Generation

#### Step 1: Generate Prompts

**POST** `/gerarPrompts`

**Headers:**
- `X-API-Key: YOUR_API_KEY`
- `Content-Type: application/json`

**Body:**
```json
{
  "cenas": [
    {
      "index": 0,
      "texto": "Scene description text"
    }
  ],
  "estilo": "Visual style description",
  "detalhe_estilo": "Detailed style specifications",
  "roteiro": "Full script/scenario",
  "agente": "System prompt for prompt generation"
}
```

**Response:**
```json
{
  "code": 200,
  "message": "Prompts generated successfully",
  "prompts": [
    {
      "index": 0,
      "prompt": "Enhanced AI-generated prompt"
    }
  ],
  "execution": {
    "startTime": "2024-01-01T00:00:00.000Z",
    "endTime": "2024-01-01T00:00:05.000Z",
    "durationMs": 5000,
    "durationSeconds": 5.0
  },
  "stats": {
    "totalScenes": 1,
    "promptsGenerated": 1,
    "successRate": "100.0%"
  }
}
```

#### Step 2: Generate Images

**POST** `/gerarImagens`

**Headers:**
- `X-API-Key: YOUR_API_KEY`
- `Content-Type: application/json`

**Body:**
```json
{
  "prompts": [
    {
      "index": 0,
      "prompt": "Enhanced AI-generated prompt from previous step"
    }
  ],
  "image_model": "runware:101",
  "altura": 1024,
  "largura": 1024
}
```

**Response:**
```json
{
  "code": 200,
  "message": "Images generated successfully",
  "images": [
    {
      "index": 0,
      "imageURL": "https://cdn.runware.ai/image-url",
      "prompt": "Enhanced AI-generated prompt"
    }
  ],
  "execution": {
    "startTime": "2024-01-01T00:00:00.000Z",
    "endTime": "2024-01-01T00:00:30.000Z",
    "durationMs": 30000,
    "durationSeconds": 30.0
  },
  "stats": {
    "totalPrompts": 1,
    "imagesGenerated": 1,
    "successRate": "100.0%"
  }
}
```

### 🎬 Video Captioning

**POST** `/caption`

**Headers:**
- `X-API-Key: YOUR_API_KEY`
- `Content-Type: application/json`

**Body:**
```json
{
  "url_video": "https://example.com/video.mp4",
  "url_srt": "https://example.com/subtitles.srt"
}
```

**Example:**
```bash
curl -X POST http://localhost:3334/caption \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url_video": "https://example.com/video.mp4",
    "url_srt": "https://example.com/subtitles.srt"
  }'
```

### 🔧 System Endpoints

**GET** `/health` - Server health status
**GET** `/caption/health` - Caption service health
**GET** `/status/:jobId` - Job status check
**GET** `/output/:jobId/:filename` - Download processed files
**GET** `/` - API documentation and endpoint list

## Configuration

### Required Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `X_API_KEY` | Authentication key | ✅ |
| `OPENAI_API_KEY` | OpenAI API key | ✅ |
| `OPENROUTER_API_KEY` | OpenRouter API key | ✅ |
| `RUNWARE_API_KEY` | Runware API key | ✅ |

### Optional Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment | development |
| `CHUNK_TIME` | Chunk duration (seconds) | 900 |
| `SPEED_FACTOR` | Processing speed multiplier | 2.0 |
| `MAX_FILE_SIZE_MB` | Maximum file size | 500 |
| `MAX_RETRIES` | Maximum retry attempts | 5 |
| `CONCURRENT_CHUNKS` | Concurrent processing | 4 |
| `OPENROUTER_MODEL` | OpenRouter model | google/gemini-2.0-flash |
| `IMAGE_GENERATION_TIMEOUT` | Image timeout (ms) | 120000 |
| `MAX_CONCURRENT_IMAGES` | Concurrent images | 5 |
| `BATCH_SIZE_IMAGES` | Image batch size | 5 |

## Architecture

### Processing Pipelines

#### 🎤 Audio Transcription Pipeline
1. **Audio Input**: Receives and validates audio file
2. **Speed Processing**: Accelerates audio 2x using FFmpeg
3. **Smart Chunking**: Each chunk < 18MB AND < 20min
4. **Transcription**: Parallel processing with Whisper API
5. **Timestamp Correction**: Adjusts timestamps to original timeline
6. **Output Generation**: Creates JSON, SRT, and TXT formats

#### 🎨 Image Generation Pipeline
1. **Prompt Generation**: AI-enhanced prompts via OpenRouter
2. **Image Creation**: High-quality generation via Runware WebSocket
3. **Batch Processing**: Concurrent processing with smart throttling
4. **Quality Assurance**: Automatic validation and retry logic

#### 🎬 Video Captioning Pipeline
1. **Input Validation**: Validates video and subtitle URLs
2. **File Processing**: Downloads and validates media files
3. **Caption Integration**: Merges subtitles with video using FFmpeg
4. **Quality Control**: Ensures output meets specifications

### Directory Structure

```
├── src/
│   ├── config/          # Configuration management
│   ├── middleware/      # Express middlewares
│   ├── routes/          # API route handlers
│   │   ├── transcription.ts    # Audio transcription
│   │   ├── imageGeneration.ts  # Image generation
│   │   └── caption.ts          # Video captioning
│   ├── services/        # Business logic services
│   │   ├── openRouterService.ts    # AI prompt generation
│   │   ├── runwareWebSocketService.ts  # Image generation
│   │   └── cleanupService.ts       # File cleanup
│   ├── types/           # TypeScript definitions
│   └── utils/           # Shared utilities
├── temp/                # Temporary processing files
├── output/              # Generated output files
└── logs/                # Application logs
```

## Production Deployment

### Environment Variables for Production
```env
NODE_ENV=production
PORT=3334
X_API_KEY=your-secure-production-key
OPENAI_API_KEY=sk-your-production-openai-key
OPENROUTER_API_KEY=sk-or-your-production-key
RUNWARE_API_KEY=your-production-runware-key
CHUNK_TIME=900
SPEED_FACTOR=2.0
MAX_FILE_SIZE_MB=500
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=10
```

### Docker Production Setup
```bash
# Production build
docker build -t api-transcricao:production .

# Run with production environment
docker run -d \
  --name api-transcricao \
  -p 3334:3334 \
  --env-file .env.production \
  --restart unless-stopped \
  api-transcricao:production
```

## Monitoring & Logging

- **Winston Logger**: Structured logging with rotation
- **Request Tracking**: Unique ID per request
- **Job Logging**: Detailed processing logs
- **Health Endpoints**: System and service health checks
- **Error Tracking**: Comprehensive error logging
- **Performance Metrics**: Processing time and success rates

## Performance Optimizations

### Audio Processing
- **Concurrent Chunking**: Parallel audio processing
- **Smart Caching**: Chunk-level result caching
- **Memory Management**: Automatic cleanup of temp files

### Image Generation
- **Batch Processing**: Optimized concurrent image generation
- **WebSocket Connections**: Persistent connections for efficiency
- **Adaptive Throttling**: Dynamic delay based on service performance

### Video Processing
- **Stream Processing**: Efficient video handling
- **Codec Optimization**: Optimal encoding settings
- **Quality Control**: Automatic resolution and bitrate optimization

## Error Handling

- **Exponential Backoff**: Intelligent retry strategies
- **Partial Success**: Graceful degradation for batch operations
- **Timeout Handling**: Configurable timeouts for all services
- **Input Validation**: Comprehensive parameter validation
- **Service Isolation**: Independent error handling per service

## Security

- **API Key Authentication**: Secure authentication mechanism
- **Rate Limiting**: Request throttling and abuse prevention
- **Input Validation**: File type, size, and content validation
- **Error Sanitization**: Safe error messages in production
- **Helmet Integration**: Security headers and protection
- **CORS Configuration**: Configurable cross-origin policies

## API Response Examples

### Transcription Response
```json
{
  "job": {
    "id": "transcription-uuid",
    "status": "completed",
    "speedFactor": 2.0,
    "sourceDurationS": 1234.5,
    "metrics": {
      "segments": 150,
      "characters": 12000,
      "wallTimeS": 45.2
    }
  },
  "transcript": {
    "segments": [
      {
        "index": 1,
        "start": 0.0,
        "end": 3.42,
        "text": "Hello world"
      }
    ],
    "fullText": "Hello world...",
    "formats": {
      "srtPath": "/output/job-id/transcription.srt",
      "txtPath": "/output/job-id/transcription.txt"
    }
  }
}
```

### Caption Response
```json
{
  "code": 200,
  "message": "Video caption added successfully",
  "video_url": "https://cdn.example.com/captioned-video.mp4",
  "execution": {
    "startTime": "2024-01-01T00:00:00.000Z",
    "endTime": "2024-01-01T00:02:30.000Z",
    "durationMs": 150000,
    "durationSeconds": 150.0
  },
  "stats": {
    "inputVideoSize": 52428800,
    "outputVideoSize": 54525952,
    "compressionRatio": "104.0%",
    "ffmpegCommand": "ffmpeg -i input.mp4 -vf subtitles=input.srt output.mp4"
  }
}
```

## Support

For issues and questions:
- Check logs in `/logs` directory
- Use health endpoints for system status
- Monitor job status with `/status/:jobId`
- Review API documentation at root endpoint `/`

## License

MIT License