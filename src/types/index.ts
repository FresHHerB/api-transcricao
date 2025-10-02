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

// Image Generation Types
export interface SceneData {
  index: number;
  texto: string;
}

export interface GenerateImageRequest {
  cenas: SceneData[];
  image_model: string;
  altura: number;
  largura: number;
  estilo: string;
  detalhe_estilo: string;
  roteiro: string;
  agente: string;
}

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterRequest {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface OpenRouterResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface RunwareImageRequest {
  taskType: 'imageInference';
  taskUUID: string;
  positivePrompt: string;
  model: string;
  width: number;
  height: number;
  outputType?: 'URL' | 'dataURI' | 'base64Data';
  outputFormat?: 'PNG' | 'JPG' | 'WEBP';
  seed?: number;
  steps?: number;
  CFGScale?: number;
}

export interface RunwareImageResponse {
  data: {
    taskType: string;
    imageUUID: string;
    taskUUID: string;
    seed: number;
    imageURL: string;
  }[];
}

export interface GeneratedImageData {
  index: number;
  imageURL: string;
  prompt: string;
}

export interface GenerateImageResponse {
  code: number;
  message: string;
  images: GeneratedImageData[];
  execution: {
    startTime: string;
    endTime: string;
    durationMs: number;
    durationSeconds: number;
  };
  stats: {
    totalScenes: number;
    promptsGenerated: number;
    imagesGenerated: number;
    successRate: string;
  };
}

// New separate endpoint types
export interface PromptData {
  index: number;
  prompt: string;
}

export interface GerarPromptsRequest {
  cenas: SceneData[];
  estilo: string;
  detalhe_estilo: string;
  roteiro: string;
  agente: string;
}

export interface GerarPromptsResponse {
  code: number;
  message: string;
  prompts: PromptData[];
  execution: {
    startTime: string;
    endTime: string;
    durationMs: number;
    durationSeconds: number;
  };
  stats: {
    totalScenes: number;
    promptsGenerated: number;
    successRate: string;
  };
}

export interface GerarImagensRequest {
  prompts: PromptData[];
  image_model: string;
  altura: number;
  largura: number;
}

export interface GerarImagensResponse {
  code: number;
  message: string;
  images: GeneratedImageData[];
  execution: {
    startTime: string;
    endTime: string;
    durationMs: number;
    durationSeconds: number;
  };
  stats: {
    totalPrompts: number;
    imagesGenerated: number;
    successRate: string;
  };
}

// Video Caption Types
export interface CaptionRequest {
  url_video: string;
  url_srt: string;
}

export interface CaptionResponse {
  code: number;
  message: string;
  video_url: string;
  execution: {
    startTime: string;
    endTime: string;
    durationMs: number;
    durationSeconds: number;
  };
  stats: {
    inputVideoSize?: number;
    outputVideoSize?: number;
    compressionRatio?: string;
    ffmpegCommand?: string;
  };
}

// Video Image-to-Video Types
export interface Img2VidRequest {
  url_image: string;
  frame_rate: number;
  duration: number;
}

export interface Img2VidResponse {
  code: number;
  message: string;
  video_url: string;
  execution: {
    startTime: string;
    endTime: string;
    durationMs: number;
    durationSeconds: number;
  };
  stats: {
    inputImage?: string;
    outputVideoSize?: number;
    frameRate?: number;
    videoDuration?: number;
    zoomFactor?: string;
    ffmpegCommand?: string;
  };
}

// Video Add Audio Types
export interface AddAudioRequest {
  url_video: string;
  url_audio: string;
}

export interface AddAudioResponse {
  code: number;
  message: string;
  video_url: string;
  execution: {
    startTime: string;
    endTime: string;
    durationMs: number;
    durationSeconds: number;
  };
  stats: {
    inputVideoSize?: number;
    inputAudioSize?: number;
    outputVideoSize?: number;
    videoDuration?: number;
    audioDuration?: number;
    timeAdjustment?: string;
    speedFactor?: number;
    ffmpegCommand?: string;
  };
}