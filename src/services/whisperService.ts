import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import retry from 'async-retry';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { AudioChunk, ChunkResult, WhisperResponse } from '../types';

export class WhisperService {
  private static readonly REPETITION_THRESHOLD = 3;
  private static readonly MIN_REPETITION_LENGTH = 5;

  private readonly baseURL = 'https://api.openai.com/v1/audio/transcriptions';
  private readonly transcriptsDir: string;

  constructor(jobId: string) {
    this.transcriptsDir = path.join(
      config.directories.temp,
      `job_${jobId}`,
      `temp_transcripts_2x`
    );
    this.ensureTranscriptsDirectory();
  }

  private ensureTranscriptsDirectory(): void {
    if (!fs.existsSync(this.transcriptsDir)) {
      fs.mkdirSync(this.transcriptsDir, { recursive: true });
    }
  }

  async transcribeChunks(chunks: AudioChunk[]): Promise<ChunkResult[]> {
    logger.info('🎯 INICIANDO TRANSCRIÇÃO COM CONTROLE RIGOROSO', {
      totalChunks: chunks.length,
      concurrentChunks: config.transcription.concurrentChunks,
      model: config.openai.model,
      maxRetries: config.transcription.maxRetries,
      strategy: 'Garantir 100% de sucesso com retry automático'
    });

    let attempt = 1;
    const maxGlobalRetries = 3;

    while (attempt <= maxGlobalRetries) {
      logger.info(`🔄 TENTATIVA ${attempt}/${maxGlobalRetries} - Processando todos os chunks`, {
        totalChunks: chunks.length,
        attempt: attempt
      });

      const results = await this.processChunksWithTracking(chunks, attempt);
      const successCount = results.filter(r => r.success).length;
      const failureCount = results.filter(r => !r.success).length;
      const successRate = (successCount / chunks.length) * 100;

      logger.info(`📊 RESULTADO TENTATIVA ${attempt}`, {
        successful: `${successCount}/${chunks.length}`,
        failed: failureCount,
        successRate: `${successRate.toFixed(1)}%`,
        status: failureCount === 0 ? '✅ SUCESSO TOTAL' : '⚠️ FALHAS DETECTADAS'
      });

      if (failureCount === 0) {
        logger.info('🎆 ✅ TRANSCRIÇÃO 100% CONCLUÍDA COM SUCESSO!', {
          totalChunks: chunks.length,
          successful: successCount,
          attempts: attempt,
          finalResult: 'TODOS OS CHUNKS PROCESSADOS COM SUCESSO'
        });
        return results.sort((a, b) => a.chunkIndex - b.chunkIndex);
      }

      const failedChunks = results.filter(r => !r.success).map(r => r.chunkIndex);
      logger.warn(`🔄 TENTATIVA ${attempt} FALHOU - Preparando retry`, {
        failedChunks: failedChunks,
        willRetry: attempt < maxGlobalRetries,
        nextAction: attempt < maxGlobalRetries ? 'Tentando novamente' : 'FALHA DEFINITIVA'
      });

      attempt++;

      if (attempt <= maxGlobalRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Delay progressivo
      }
    }

    // Se chegou aqui, falhou todas as tentativas
    throw new Error(`FALHA CRÍTICA: Impossível processar todos os chunks após ${maxGlobalRetries} tentativas`);
  }

  private async processChunksWithTracking(chunks: AudioChunk[], globalAttempt: number): Promise<ChunkResult[]> {
    const semaphore = new Semaphore(config.transcription.concurrentChunks);
    const results: ChunkResult[] = [];
    let processedCount = 0;
    let successCount = 0;
    let failureCount = 0;

    const updateProgress = (result: ChunkResult) => {
      processedCount++;
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }

      const progress = Math.round((processedCount / chunks.length) * 100);
      const status = result.success ? '✅' : '❌';

      logger.info(`${status} Chunk ${result.chunkIndex}/${chunks.length} [${progress}%]`, {
        chunk: `${processedCount}/${chunks.length}`,
        successful: successCount,
        failed: failureCount,
        status: result.success ? 'SUCESSO' : `FALHA: ${result.error}`,
        globalAttempt: globalAttempt,
        progress: `${progress}%`
      });
    };

    const promises = chunks.map(async (chunk) => {
      return semaphore.acquire(async () => {
        const result = await this.transcribeChunk(chunk);
        updateProgress(result);
        results.push(result);
        return result;
      });
    });

    await Promise.all(promises);
    return results;
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
          chunkStartTime: chunk.startTime,
          chunkDuration: chunk.duration,
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
          logger.info(`🤖 Enviando Chunk ${chunk.index} para Whisper API`, {
            chunkIndex: chunk.index,
            attempt: attemptNumber,
            chunkPath: path.basename(chunk.path),
            model: config.openai.model,
            timeout: `${config.transcription.requestTimeout / 1000}s`
          });

          try {
            const response = await this.callWhisperAPI(chunk.path);

            this.validateWhisperResponse(response, chunk);

            fs.writeFileSync(cacheFile, JSON.stringify(response, null, 2));

            logger.info(`✅ Chunk ${chunk.index} transcrito com sucesso`, {
              chunkIndex: chunk.index,
              segments: response.segments?.length || 0,
              duration: `${response.duration?.toFixed(2)}s`,
              language: response.language || 'N/A',
              characters: response.text?.length || 0,
              validation: '✅ PASSED',
              cached: 'Salvando resultado em cache'
            });

            return {
              chunkIndex: chunk.index,
              chunkPath: chunk.path,
              chunkStartTime: chunk.startTime,
              chunkDuration: chunk.duration,
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
        chunkStartTime: chunk.startTime,
        chunkDuration: chunk.duration,
        success: false,
        error: errorMessage,
        retries: retryCount
      };
    }
  }

  private validateWhisperResponse(response: WhisperResponse, chunk: AudioChunk): void {
    const segments = response.segments ?? [];
    const trimmedTextLength = response.text?.trim().length ?? 0;
    const rawDuration = response.duration;
    const responseDuration = rawDuration ?? 0;
    const isEmptyResult = segments.length === 0;
    const hasMinimalText = trimmedTextLength < 10;
    const isSuspiciouslyShort = responseDuration < chunk.duration * 0.1;

    if (isEmptyResult || (hasMinimalText && isSuspiciouslyShort)) {
      const suspicionReason = isEmptyResult
        ? 'No segments returned'
        : hasMinimalText
          ? `Minimal text (${response.text?.length || 0} chars)`
          : 'Suspiciously short duration';

      logger.warn('?? WHISPER API FALHA SILENCIOSA DETECTADA', {
        chunkIndex: chunk.index,
        suspicion: suspicionReason,
        segments: segments.length,
        textLength: response.text?.length || 0,
        responseDuration: rawDuration !== undefined ? rawDuration.toFixed(2) : 'N/A',
        expectedMinDuration: (chunk.duration * 0.1).toFixed(2),
        action: 'Marcando chunk como falha'
      });

      throw new Error(`Whisper API returned suspicious result: ${suspicionReason}`);
    }

    this.detectRepeatedSegments(response, chunk);
  }

  private detectRepeatedSegments(response: WhisperResponse, chunk: AudioChunk): void {
    const segments = response.segments ?? [];
    if (segments.length < WhisperService.REPETITION_THRESHOLD) {
      return;
    }

    for (let i = 0; i <= segments.length - WhisperService.REPETITION_THRESHOLD; i++) {
      const baseText = this.normalizeSegmentText(segments[i]?.text ?? '');
      if (baseText.length < WhisperService.MIN_REPETITION_LENGTH) {
        continue;
      }

      let isRepetitive = true;
      for (let j = 1; j < WhisperService.REPETITION_THRESHOLD; j++) {
        const compareText = this.normalizeSegmentText(segments[i + j]?.text ?? '');
        if (compareText !== baseText) {
          isRepetitive = false;
          break;
        }
      }

      if (isRepetitive) {
        const firstSegment = segments[i];
        const lastSegment = segments[i + WhisperService.REPETITION_THRESHOLD - 1];
        if (!firstSegment || !lastSegment) {
          continue;
        }

        const trimmedText = firstSegment.text.trim();

        logger.warn('?? WHISPER API DETECTOU ALUCINAÇÃO (REPETIÇÃO)', {
          chunkIndex: chunk.index,
          repeatedText: trimmedText.slice(0, 120),
          count: WhisperService.REPETITION_THRESHOLD,
          startTime: firstSegment.start.toFixed(2),
          endTime: lastSegment.end.toFixed(2),
          action: 'Marcando chunk como falha'
        });

        throw new Error(`Whisper API hallucination detected: repeated text "${trimmedText}"`);
      }
    }
  }

  private normalizeSegmentText(text: string): string {
    return text
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private async callWhisperAPI(audioPath: string): Promise<WhisperResponse> {
    // CRITICAL VALIDATION: Check file before sending to API
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    // Validate file size
    if (stats.size === 0) {
      throw new Error(`Audio file is empty (0 bytes): ${path.basename(audioPath)}`);
    }

    if (fileSizeMB > 25) {
      throw new Error(`Audio file too large (${fileSizeMB.toFixed(2)}MB > 25MB limit): ${path.basename(audioPath)}`);
    }

    if (stats.size < 1000) { // Less than 1KB is suspicious
      logger.warn('⚠️ Audio file very small, may cause API errors', {
        audioPath: path.basename(audioPath),
        sizeBytes: stats.size,
        sizeMB: fileSizeMB.toFixed(3),
        warning: 'File might be too short for transcription'
      });
    }

    logger.debug('📤 Sending to Whisper API', {
      audioPath: path.basename(audioPath),
      sizeBytes: stats.size,
      sizeMB: fileSizeMB.toFixed(2),
      model: config.openai.model
    });

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
