# API Transcrição

A robust transcription API with 2x speed processing, smart chunking (18MB AND 20min limits), and multiple output formats. Built for production deployment on EasyPanel with VPS Hostinger KVM 2.

## Features

- **High-Performance Processing**: 2x speed acceleration with FFmpeg
- **Chunked Processing**: Asynchronous 15-minute chunks for optimal performance
- **Multiple Formats**: JSON, SRT, and TXT output formats
- **Robust Error Handling**: Exponential backoff retry mechanism
- **Authentication**: Bearer token authentication
- **Rate Limiting**: Configurable request limits
- **Health Monitoring**: Built-in health checks
- **Docker Ready**: Full containerization support

## Quick Start

### Prerequisites

- Node.js 18+
- FFmpeg
- OpenAI API Key

### Installation

1. Clone and install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env with your configuration
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

## API Usage

### Transcribe Audio

**POST** `/transcribe`

**Headers:**
- `Authorization: Bearer YOUR_API_KEY`
- `Content-Type: multipart/form-data`

**Body:**
- `audio` (file): Audio file (mp3, wav, m4a, ogg, flac, aac)
- `speed` (optional): Processing speed factor (1-3, default: 2)
- `format` (optional): Output format (json, srt, txt, default: json)

**Example:**
```bash
curl -X POST http://localhost:3000/transcribe \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "audio=@audio.mp3" \
  -F "speed=2" \
  -F "format=json"
```

### Health Check

**GET** `/health`

Returns server health status and metrics.

### Job Status

**GET** `/status/:jobId`

**Headers:**
- `Authorization: Bearer YOUR_API_KEY`

Check the status of a transcription job.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment | development |
| `X_API_KEY` | Authentication key | required |
| `OPENAI_API_KEY` | OpenAI API key | required |
| `CHUNK_TIME` | Chunk duration (seconds) | 900 |
| `SPEED_FACTOR` | Processing speed multiplier | 2.0 |
| `MAX_FILE_SIZE_MB` | Maximum file size | 500 |
| `MAX_RETRIES` | Maximum retry attempts | 5 |
| `CONCURRENT_CHUNKS` | Concurrent processing | 4 |

## Response Formats

### JSON Response (Default)
```json
{
  "job": {
    "id": "uuid",
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
      "srtPath": "/path/to/file.srt",
      "txtPath": "/path/to/file.txt"
    }
  }
}
```

### SRT Format
```
1
00:00:00,000 --> 00:00:03,420
Hello world

2
00:00:03,420 --> 00:00:06,840
This is a transcription
```

### TXT Format
```
Hello world. This is a transcription...
```

## Architecture

### Processing Pipeline

1. **Audio Input**: Receives and validates audio file
2. **Speed Processing**: Accelerates audio 2x using FFmpeg (no compression)
3. **Smart Chunking**: Each chunk satisfies BOTH limits: < 18MB AND < 20min
4. **Transcription**: Sends chunks to Whisper API with parallel processing and retry logic
5. **Timestamp Correction**: Adjusts timestamps back to original speed timeline
6. **Output Generation**: Creates JSON, SRT, and TXT formats

### Directory Structure

```
├── src/
│   ├── config/          # Configuration management
│   ├── middleware/      # Express middlewares
│   ├── routes/          # API routes
│   ├── services/        # Business logic
│   ├── types/           # TypeScript definitions
│   └── utils/           # Utilities
├── temp/                # Temporary processing files
├── output/              # Generated transcription files
└── logs/                # Application logs
```

## Production Deployment

### EasyPanel Setup

1. Create new application in EasyPanel
2. Use Git repository deployment
3. Set environment variables in EasyPanel
4. Configure domain and SSL
5. Monitor through EasyPanel dashboard

### Environment Variables for Production
```env
NODE_ENV=production
PORT=3000
X_API_KEY=your-secure-production-key
OPENAI_API_KEY=sk-your-production-openai-key
CHUNK_TIME=900
SPEED_FACTOR=2.0
MAX_FILE_SIZE_MB=500
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=10
```

## Monitoring & Logging

- **Winston Logger**: Structured logging with rotation
- **Request Tracking**: Each request gets unique ID
- **Job Logging**: Separate log file per transcription job
- **Health Endpoint**: System health and metrics
- **Error Tracking**: Comprehensive error logging

## Performance Optimizations

- **Async Processing**: Concurrent chunk processing
- **Caching**: Chunk-level result caching
- **Compression**: Audio compression for faster uploads
- **Rate Limiting**: Prevents API overload
- **Memory Management**: Automatic cleanup of temp files

## Error Handling

- **Exponential Backoff**: Retry failed chunks with increasing delays
- **Partial Success**: Continue processing even if some chunks fail
- **Timeout Handling**: Configurable timeouts for all operations
- **Validation**: Input validation for all parameters

## Security

- **Bearer Authentication**: API key-based authentication
- **Rate Limiting**: Request throttling
- **Input Validation**: File type and size validation
- **Error Sanitization**: Safe error messages in production
- **Helmet**: Security headers
- **CORS**: Configurable cross-origin policies

## Support

For issues and questions:
- Check logs in `/logs` directory
- Use health endpoint for system status
- Monitor job status with `/status/:jobId`

## License

MIT License