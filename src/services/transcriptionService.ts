import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env';
import { createJobLogger, logger } from '../utils/logger';
import { AudioProcessor } from './audioProcessor';
import { WhisperService } from './whisperService';
import { OutputFormatter } from './outputFormatter';
import {
  TranscriptionResult,
  TranscriptionJob,
  ChunkResult,
  TranscriptionSegment,
  ProcessingMetrics,
  OutputFormat
} from '../types';

export class TranscriptionService {
  async transcribeAudio(
    audioPath: string,
    speedFactor?: number,
    format: OutputFormat = 'json'
  ): Promise<TranscriptionResult> {
    const jobId = uuidv4();
    const jobLogger = createJobLogger(jobId);
    const metrics: ProcessingMetrics = {
      startTime: Date.now(),
      chunksProcessed: 0,
      totalChunks: 0,
      failedChunks: 0,
      retryAttempts: 0
    };

    jobLogger.info('🚀 INICIANDO JOB DE TRANSCRIÇÃO', {
      jobId,
      audioPath,
      speedFactor: speedFactor || config.audio.speedFactor,
      format,
      timestamp: new Date().toISOString(),
      phase: 'INITIALIZATION'
    });

    logger.info('📋 Job iniciado - Configurações', {
      jobId,
      chunkTime: config.audio.chunkTime,
      concurrentChunks: config.transcription.concurrentChunks,
      maxRetries: config.transcription.maxRetries
    });

    const audioProcessor = new AudioProcessor(jobId);
    const whisperService = new WhisperService(jobId);
    const outputFormatter = new OutputFormatter(jobId);

    try {
      jobLogger.info('🎵 FASE 1: Processando áudio', {
        phase: 'AUDIO_PROCESSING',
        inputPath: audioPath,
        speedFactor: speedFactor || config.audio.speedFactor
      });

      const { processedPath, duration } = await audioProcessor.processAudio(audioPath);

      jobLogger.info('✅ ÁUDIO PROCESSADO COM SUCESSO', {
        phase: 'AUDIO_PROCESSING_COMPLETE',
        duration,
        processedPath,
        originalDurationEstimate: duration / (speedFactor || config.audio.speedFactor),
        compressionRatio: '2x speed + OGG compression'
      });

      jobLogger.info('✂️ FASE 2: Criando chunks', {
        phase: 'CHUNKING',
        totalDuration: duration,
        chunkSize: config.audio.chunkTime,
        estimatedChunks: Math.ceil(duration / config.audio.chunkTime)
      });

      const chunks = await audioProcessor.createChunks(processedPath, duration);
      metrics.totalChunks = chunks.length;

      jobLogger.info('📦 CHUNKS CRIADOS COM SUCESSO', {
        phase: 'CHUNKING_COMPLETE',
        totalChunks: chunks.length,
        averageChunkDuration: duration / chunks.length,
        chunksInfo: chunks.map((c, i) => ({
          index: c.index,
          duration: c.duration,
          path: path.basename(c.path)
        }))
      });

      jobLogger.info('🤖 FASE 3: Transcrevendo com OpenAI Whisper', {
        phase: 'TRANSCRIPTION_START',
        totalChunks: chunks.length,
        concurrency: config.transcription.concurrentChunks,
        model: config.openai.model
      });

      const chunkResults = await whisperService.transcribeChunks(chunks);
      metrics.chunksProcessed = chunkResults.filter(r => r.success).length;
      metrics.failedChunks = chunkResults.filter(r => !r.success).length;
      metrics.retryAttempts = chunkResults.reduce((sum, r) => sum + r.retries, 0);

      jobLogger.info('🎯 TRANSCRIÇÃO CONCLUÍDA', {
        phase: 'TRANSCRIPTION_COMPLETE',
        successful: metrics.chunksProcessed,
        failed: metrics.failedChunks,
        totalRetries: metrics.retryAttempts,
        successRate: `${((metrics.chunksProcessed / chunks.length) * 100).toFixed(1)}%`,
        averageRetriesPerChunk: (metrics.retryAttempts / chunks.length).toFixed(1)
      });

      jobLogger.info('⏰ FASE 4: Corrigindo timestamps', {
        phase: 'TIMESTAMP_CORRECTION',
        speedFactor: speedFactor || config.audio.speedFactor,
        totalChunks: chunkResults.length
      });

      const { segments, warnings } = this.processChunkResults(
        chunkResults,
        speedFactor || config.audio.speedFactor
      );

      jobLogger.info('✅ TIMESTAMPS CORRIGIDOS', {
        phase: 'TIMESTAMP_CORRECTION_COMPLETE',
        totalSegments: segments.length,
        warningsCount: warnings.length,
        timelineSpan: segments.length > 0 ? `${segments[0]?.start?.toFixed(2)}s - ${segments[segments.length-1]?.end?.toFixed(2)}s` : 'N/A'
      });

      const fullText = segments.map(s => s.text).join(' ');
      const job: TranscriptionJob = {
        id: jobId,
        status: metrics.failedChunks > 0 ? 'completed_with_warnings' : 'completed',
        speedFactor: speedFactor || config.audio.speedFactor,
        chunkLengthS: config.audio.chunkTime,
        sourceDurationS: duration,
        processedChunks: metrics.chunksProcessed,
        failedChunks: chunkResults
          .filter(r => !r.success)
          .map(r => path.basename(r.chunkPath)),
        metrics: {
          segments: segments.length,
          characters: fullText.length,
          wallTimeS: (Date.now() - metrics.startTime) / 1000
        }
      };

      metrics.endTime = Date.now();

      let srtPath: string | undefined;
      let txtPath: string | undefined;

      jobLogger.info('📄 FASE 5: Gerando arquivos de saída', {
        phase: 'OUTPUT_GENERATION',
        format,
        totalCharacters: fullText.length,
        totalSegments: segments.length
      });

      if (format === 'json') {
        const outputs = await outputFormatter.generateAllFormats(segments, fullText, jobId);
        srtPath = outputs.srtPath;
        txtPath = outputs.txtPath;
        jobLogger.info('📁 Arquivos JSON + SRT + TXT gerados', {
          srtPath: path.basename(outputs.srtPath),
          txtPath: path.basename(outputs.txtPath)
        });
      } else if (format === 'srt') {
        srtPath = await outputFormatter.generateSRT(segments, jobId);
        jobLogger.info('📁 Arquivo SRT gerado', { srtPath: path.basename(srtPath) });
      } else if (format === 'txt') {
        txtPath = await outputFormatter.generateTXT(fullText, jobId);
        jobLogger.info('📁 Arquivo TXT gerado', { txtPath: path.basename(txtPath) });
      }

      const result: TranscriptionResult = {
        job,
        transcript: {
          segments,
          fullText,
          formats: srtPath || txtPath ? {
            ...(srtPath && { srtPath }),
            ...(txtPath && { txtPath })
          } : undefined
        },
        warnings
      };

      const processingStats = {
        totalDuration: duration,
        segmentsGenerated: segments.length,
        charactersTranscribed: fullText.length,
        chunksProcessed: metrics.chunksProcessed,
        chunksTotal: metrics.totalChunks,
        failedChunks: metrics.failedChunks,
        totalRetries: metrics.retryAttempts,
        processingTimeSeconds: job.metrics.wallTimeS,
        speedup: `${((duration / job.metrics.wallTimeS)).toFixed(2)}x real-time`,
        efficiency: `${((metrics.chunksProcessed / metrics.totalChunks) * 100).toFixed(1)}% success`
      };

      jobLogger.info('🎉 JOB CONCLUÍDO COM SUCESSO! 🎉', {
        phase: 'JOB_COMPLETE',
        jobId,
        status: job.status,
        finalStats: processingStats,
        warnings: warnings.length > 0 ? warnings : 'Nenhum aviso',
        timestamp: new Date().toISOString()
      });

      logger.info('📊 Resumo da transcrição', {
        jobId,
        ...processingStats
      });

      return result;
    } catch (error) {
      metrics.endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      const failureStats = {
        jobId,
        error: errorMessage,
        wallTimeS: (metrics.endTime - metrics.startTime) / 1000,
        chunksProcessed: metrics.chunksProcessed,
        totalChunks: metrics.totalChunks,
        phase: 'JOB_FAILED'
      };

      jobLogger.error('❌ JOB FALHOU', failureStats);
      logger.error('💥 Falha na transcrição', failureStats);

      throw new Error(`Transcription failed: ${errorMessage}`);
    } finally {
      setTimeout(() => {
        audioProcessor.cleanup();
      }, 5 * 60 * 1000);
    }
  }

  private processChunkResults(
    chunkResults: ChunkResult[],
    speedFactor: number
  ): { segments: TranscriptionSegment[]; warnings: string[] } {
    const segments: TranscriptionSegment[] = [];
    const warnings: string[] = [];
    let timeOffset = 0;
    let segmentIndex = 1;

    for (const result of chunkResults) {
      if (result.success && result.segments) {
        for (const segment of result.segments) {
          const correctedSegment: TranscriptionSegment = {
            index: segmentIndex++,
            start: segment.start * speedFactor + timeOffset,
            end: segment.end * speedFactor + timeOffset,
            text: segment.text.trim()
          };

          if (correctedSegment.text) {
            segments.push(correctedSegment);
          }
        }

        if (result.segments.length > 0) {
          const lastSegment = result.segments[result.segments.length - 1];
          if (lastSegment) {
            timeOffset = lastSegment.end * speedFactor + timeOffset;
          }
        } else {
          timeOffset += config.audio.chunkTime * speedFactor;
        }
      } else {
        const chunkName = path.basename(result.chunkPath);
        const warning = `${chunkName}: ${result.error || 'transcription failed'}; timestamps estimated`;
        warnings.push(warning);

        timeOffset += config.audio.chunkTime * speedFactor;

        logger.warn('Chunk failed, estimating time offset', {
          chunkIndex: result.chunkIndex,
          chunkPath: result.chunkPath,
          estimatedOffset: timeOffset,
          error: result.error
        });
      }
    }

    return { segments, warnings };
  }

  async getJobStatus(jobId: string): Promise<{ exists: boolean; completed: boolean }> {
    const tempDir = path.join(config.directories.temp, `job_${jobId}`);
    const logFile = path.join(config.directories.logs, `job-${jobId}.log`);

    return {
      exists: fs.existsSync(tempDir) || fs.existsSync(logFile),
      completed: !fs.existsSync(tempDir) && fs.existsSync(logFile)
    };
  }
}