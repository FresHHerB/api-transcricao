export interface TranscriptionSegment {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
  avg_logprob: number;
  compression_ratio: number;
  no_speech_prob: number;
}

export interface WhisperResponse {
  task: string;
  language: string;
  duration: number;
  text: string;
  segments: WhisperSegment[];
}

export interface AudioChunk {
  index: number;
  path: string;
  duration: number;
  startTime: number;
}

export interface ChunkResult {
  chunkIndex: number;
  chunkPath: string;
  chunkStartTime: number; // Tempo de início original do chunk (sem speed factor)
  chunkDuration: number;  // Duração original do chunk (para estimativas em caso de falha)
  success: boolean;
  segments?: WhisperSegment[];
  error?: string;
  retries: number;
  duration?: number;
}

export interface TranscriptionJob {
  id: string;
  status: 'processing' | 'completed' | 'completed_with_warnings' | 'failed';
  speedFactor: number;
  chunkLengthS: number;
  sourceDurationS?: number;
  processedChunks: number;
  failedChunks: string[];
  metrics: {
    segments: number;
    characters: number;
    wallTimeS: number;
  };
}

export interface TranscriptionResult {
  job: TranscriptionJob;
  transcript: {
    segments: TranscriptionSegment[];
    fullText: string;
    formats?: {
      srtPath?: string;
      txtPath?: string;
    } | undefined;
  };
  warnings?: string[];
}

export interface ProcessingMetrics {
  startTime: number;
  endTime?: number;
  chunksProcessed: number;
  totalChunks: number;
  failedChunks: number;
  retryAttempts: number;
}

export type OutputFormat = 'json' | 'srt' | 'txt';

export interface TranscribeRequest {
  speed?: number;
  format?: OutputFormat;
}

export interface SilenceSegment {
  start: number;
  end: number;
  duration: number;
}

export interface SmartChunkPlan {
  index: number;
  targetStart: number;
  targetEnd: number;
  actualStart: number;
  actualEnd: number;
  duration: number;
  usedSilence: boolean;
  silenceStart?: number;
  silenceEnd?: number;
  estimatedSizeMB: number;
}