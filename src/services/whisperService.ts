import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import retry from 'async-retry';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { AudioChunk, ChunkResult, WhisperResponse } from '../types';

export class WhisperService {
  private readonly baseURL = 'https://api.openai.com/v1/audio/transcriptions';
  private readonly transcriptsDir: string;

  constructor(jobId: string) {
    this.transcriptsDir = path.join(
      config.directories.temp,
      `job_${jobId}`,
      `temp_transcripts_${config.audio.speedFactor}x`
    );
    this.ensureTranscriptsDirectory();
  }

  private ensureTranscriptsDirectory(): void {
    if (!fs.existsSync(this.transcriptsDir)) {
      fs.mkdirSync(this.transcriptsDir, { recursive: true });
    }
  }

  async transcribeChunks(chunks: AudioChunk[]): Promise<ChunkResult[]> {
    logger.info('🎯 Iniciando transcrição em lote', {
      totalChunks: chunks.length,
      concurrentChunks: config.transcription.concurrentChunks,
      model: config.openai.model,
      maxRetries: config.transcription.maxRetries,
      strategy: 'Parallel processing with semaphore'
    });

    const semaphore = new Semaphore(config.transcription.concurrentChunks);
    const results: ChunkResult[] = [];

    const promises = chunks.map(async (chunk) => {
      return semaphore.acquire(async () => {
        const result = await this.transcribeChunk(chunk);
        results.push(result);
        return result;
      });
    });

    await Promise.all(promises);

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    const successRate = (successCount / chunks.length) * 100;
    const totalRetries = results.reduce((sum, r) => sum + r.retries, 0);

    logger.info('🎆 TRANSCRIÇÃO CONCLUÍDA', {
      totalChunks: chunks.length,
      successful: successCount,
      failed: failureCount,
      successRate: `${successRate.toFixed(1)}%`,
      totalRetries,
      avgRetriesPerChunk: (totalRetries / chunks.length).toFixed(2),
      readyForProcessing: true
    });

    return results.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  private async transcribeChunk(chunk: AudioChunk): Promise<ChunkResult> {
    const cacheFile = path.join(this.transcriptsDir, `chunk_${String(chunk.index).padStart(3, '0')}.json`);

    if (fs.existsSync(cacheFile)) {
      logger.info('📋 Cache encontrado', {
        chunkIndex: chunk.index,
        cacheFile: path.basename(cacheFile),
        action: 'Reutilizando transcrição salva'
      });
      try {
        const cachedData = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as WhisperResponse;
        return {
          chunkIndex: chunk.index,
          chunkPath: chunk.path,
          success: true,
          segments: cachedData.segments,
          retries: 0,
          duration: cachedData.duration
        };
      } catch (error) {
        logger.warn('⚠️ Cache corrompido, reprocessando', {
          chunkIndex: chunk.index,
          cacheFile: path.basename(cacheFile),
          error: error instanceof Error ? error.message : 'Unknown error',
          action: 'Removendo cache e tentando novamente'
        });
        fs.unlinkSync(cacheFile);
      }
    }

    const startTime = Date.now();
    let retryCount = 0;

    try {
      const result = await retry(
        async (bail, attemptNumber) => {
          retryCount = attemptNumber - 1;
          logger.info('🤖 Enviando para Whisper API', {
            chunkIndex: chunk.index,
            attempt: attemptNumber,
            chunkPath: path.basename(chunk.path),
            model: config.openai.model,
            timeout: `${config.transcription.requestTimeout / 1000}s`
          });

          try {
            const response = await this.callWhisperAPI(chunk.path);

            fs.writeFileSync(cacheFile, JSON.stringify(response, null, 2));

            logger.info('✅ Transcrição bem-sucedida', {
              chunkIndex: chunk.index,
              segments: response.segments?.length || 0,
              duration: `${response.duration?.toFixed(2)}s`,
              language: response.language || 'N/A',
              characters: response.text?.length || 0,
              cached: 'Salvando resultado em cache'
            });

            return {
              chunkIndex: chunk.index,
              chunkPath: chunk.path,
              success: true,
              segments: response.segments,
              retries: retryCount,
              duration: response.duration
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger.warn('❌ Tentativa falhou', {
              chunkIndex: chunk.index,
              attempt: `${attemptNumber}/${config.transcription.maxRetries + 1}`,
              error: errorMessage,
              willRetry: attemptNumber <= config.transcription.maxRetries
            });

            if (axios.isAxiosError(error)) {
              if (error.response?.status === 400 || error.response?.status === 413) {
                bail(new Error(`Permanent error (${error.response.status}): ${errorMessage}`));
                return;
              }
            }

            throw error;
          }
        },
        {
          retries: config.transcription.maxRetries,
          factor: 2,
          minTimeout: config.transcription.initialRetryDelay,
          maxTimeout: 30000,
          randomize: true,
          onRetry: (error, attempt) => {
            const delay = Math.min(config.transcription.initialRetryDelay * Math.pow(2, attempt - 1), 30000);
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn('🔄 Tentativa de retry', {
              chunkIndex: chunk.index,
              attempt: `${attempt}/${config.transcription.maxRetries}`,
              nextRetryIn: `${delay}ms`,
              error: errorMessage,
              strategy: 'Exponential backoff'
            });
          }
        }
      );

      const elapsedTime = Date.now() - startTime;
      logger.info('🎯 Chunk processado com sucesso', {
        chunkIndex: chunk.index,
        retries: retryCount,
        elapsedTimeMs: elapsedTime,
        efficiency: retryCount === 0 ? 'Primeira tentativa' : `Sucesso após ${retryCount} retries`,
        segments: result?.segments?.length || 0
      });

      if (!result) {
        throw new Error('Result is undefined after retry');
      }

      return result;
    } catch (error) {
      const elapsedTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('💥 CHUNK FALHOU COMPLETAMENTE', {
        chunkIndex: chunk.index,
        totalRetries: retryCount,
        elapsedTimeMs: elapsedTime,
        finalError: errorMessage,
        impact: 'Timestamps serão estimados para este chunk'
      });

      return {
        chunkIndex: chunk.index,
        chunkPath: chunk.path,
        success: false,
        error: errorMessage,
        retries: retryCount
      };
    }
  }

  private async callWhisperAPI(audioPath: string): Promise<WhisperResponse> {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioPath));
    formData.append('model', config.openai.model);
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    const response = await axios.post<WhisperResponse>(this.baseURL, formData, {
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
        ...formData.getHeaders()
      },
      timeout: config.transcription.requestTimeout,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    if (!response.data.segments || !Array.isArray(response.data.segments)) {
      throw new Error('Invalid response format: segments missing or not an array');
    }

    return response.data;
  }
}

class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire<T>(task: () => Promise<T>): Promise<T> {
    await this.waitForPermit();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private waitForPermit(): Promise<void> {
    return new Promise((resolve) => {
      if (this.permits > 0) {
        this.permits--;
        resolve();
      } else {
        this.waitQueue.push(resolve);
      }
    });
  }

  private release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}