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

    const effectiveSpeedFactor = speedFactor ?? config.audio.speedFactor ?? 2.0;

    jobLogger.info('🚀 INICIANDO JOB DE TRANSCRIÇÃO', {
      jobId,
      audioPath,
      speedFactor: effectiveSpeedFactor,
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

    const audioProcessor = new AudioProcessor(jobId, effectiveSpeedFactor);
    const whisperService = new WhisperService(jobId);
    const outputFormatter = new OutputFormatter(jobId, effectiveSpeedFactor);

    try {
      jobLogger.info('🎵 FASE 1: Processando áudio', {
        phase: 'AUDIO_PROCESSING',
        inputPath: audioPath,
        speedFactor: effectiveSpeedFactor
      });

      const { processedPath, duration, originalDuration, originalSizeBytes } = await audioProcessor.processAudio(audioPath);

      jobLogger.info('✅ ÁUDIO PROCESSADO COM SUCESSO', {
        phase: 'AUDIO_PROCESSING_COMPLETE',
        acceleratedDuration: duration,
        originalDuration,
        processedPath,
        speedFactor: effectiveSpeedFactor,
        processingPipeline: '2x speed + lossless WAV'
      });

      jobLogger.info('✂️ FASE 2: Criando chunks', {
        phase: 'CHUNKING',
        originalDuration,
        acceleratedDuration: duration,
        durationLimitSeconds: config.audio.chunkTime,
        sizeLimitMB: 18,
        originalSizeMB: (originalSizeBytes / (1024 * 1024)).toFixed(2),
        speedFactor: effectiveSpeedFactor
      });

      const chunks = await audioProcessor.createChunks(processedPath, duration, originalDuration, originalSizeBytes);
      metrics.totalChunks = chunks.length;

      const chunkSizeMBStats = chunks.map(chunk => {
        try {
          const stats = fs.statSync(chunk.path);
          return stats.size / (1024 * 1024);
        } catch (error) {
          logger.warn('⚠️ Não foi possível ler tamanho do chunk', {
            chunkPath: chunk.path,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          return 0;
        }
      });

      const maxChunkDuration = chunks.reduce((max, chunk) => Math.max(max, chunk.duration), 0);
      const maxChunkSizeMB = chunkSizeMBStats.length > 0 ? Math.max(...chunkSizeMBStats) : 0;
      const averageChunkSizeMB = chunkSizeMBStats.length > 0
        ? chunkSizeMBStats.reduce((sum, size) => sum + size, 0) / chunkSizeMBStats.length
        : 0;

      jobLogger.info('📦 CHUNKS CRIADOS COM SUCESSO', {
        phase: 'CHUNKING_COMPLETE',
        totalChunks: chunks.length,
        averageOriginalChunkDuration: chunks.length ? originalDuration / chunks.length : 0,
        maxChunkDuration,
        maxChunkSizeMB: maxChunkSizeMB.toFixed(2),
        averageChunkSizeMB: averageChunkSizeMB.toFixed(2),
        durationLimitSeconds: config.audio.chunkTime,
        sizeLimitMB: 18,
        chunksInfo: chunks.map((c) => ({
          index: c.index,
          originalDuration: c.duration,
          originalStartTime: c.startTime,
          path: path.basename(c.path)
        }))
      });

      jobLogger.info('🤖 FASE 3: Transcrevendo com OpenAI Whisper', {
        phase: 'TRANSCRIPTION_START',
        totalChunks: chunks.length,
        concurrency: config.transcription.concurrentChunks,
        model: config.openai.model
      });

      let chunkResults: any;
      let transcriptionAttempt = 1;
      const maxTranscriptionRetries = 3;

      while (transcriptionAttempt <= maxTranscriptionRetries) {
        jobLogger.info(`🎥 FASE 3.${transcriptionAttempt}: Transcrição (Tentativa ${transcriptionAttempt}/${maxTranscriptionRetries})`, {
          phase: `TRANSCRIPTION_ATTEMPT_${transcriptionAttempt}`,
          totalChunks: chunks.length,
          attempt: transcriptionAttempt,
          strategy: 'Garantir 100% de sucesso'
        });

        try {
          chunkResults = await whisperService.transcribeChunks(chunks);

          // Validação rigorosa - DEVE ser 100% sucesso
          const successfulChunks = chunkResults.filter((r: ChunkResult) => r.success);
          const failedChunks = chunkResults.filter((r: ChunkResult) => !r.success);

          if (failedChunks.length === 0) {
            jobLogger.info('✅ TRANSCRIÇÃO 100% CONCLUÍDA!', {
              phase: 'TRANSCRIPTION_SUCCESS',
              totalChunks: chunks.length,
              successful: successfulChunks.length,
              failed: 0,
              attempts: transcriptionAttempt,
              status: 'SUCESSO TOTAL GARANTIDO'
            });
            break; // Sair do loop, sucesso!
          } else {
            throw new Error(`${failedChunks.length} chunks falharam na transcrição`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';

          jobLogger.error(`❌ FALHA NA TRANSCRIÇÃO - Tentativa ${transcriptionAttempt}`, {
            phase: `TRANSCRIPTION_FAILED_${transcriptionAttempt}`,
            error: errorMsg,
            attempt: transcriptionAttempt,
            maxAttempts: maxTranscriptionRetries,
            willRetry: transcriptionAttempt < maxTranscriptionRetries
          });

          if (transcriptionAttempt >= maxTranscriptionRetries) {
            throw new Error(`FALHA DEFINITIVA: Transcrição falhou após ${maxTranscriptionRetries} tentativas: ${errorMsg}`);
          }

          transcriptionAttempt++;

          // Delay progressivo entre tentativas
          const delay = 3000 * transcriptionAttempt;
          jobLogger.info(`🔄 Aguardando ${delay}ms antes da próxima tentativa...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      // Atualizar métricas apenas após sucesso total
      metrics.chunksProcessed = chunkResults.filter((r: ChunkResult) => r.success).length;
      metrics.failedChunks = 0; // Garantimos que seja 0
      metrics.retryAttempts = chunkResults.reduce((sum: number, r: ChunkResult) => sum + r.retries, 0);

      jobLogger.info('⏰ FASE 4: Corrigindo timestamps', {
        phase: 'TIMESTAMP_CORRECTION',
        speedFactor: effectiveSpeedFactor,
        totalChunks: chunkResults.length
      });

      // Validação adicional antes do processamento de timestamps
      const totalSegments = chunkResults.reduce((sum: number, r: ChunkResult) => sum + (r.segments?.length || 0), 0);
      if (totalSegments === 0) {
        throw new Error('FALHA CRÍTICA: Nenhum segmento foi transcrito com sucesso');
      }

      jobLogger.info('✅ INICIANDO PROCESSAMENTO DE TIMESTAMPS', {
        phase: 'TIMESTAMP_PROCESSING_START',
        totalChunkResults: chunkResults.length,
        totalSegments: totalSegments,
        allChunksSuccessful: true
      });

      const { segments, warnings } = this.processChunkResults(
        chunkResults,
        effectiveSpeedFactor
      );

      jobLogger.info('✅ TIMESTAMPS CORRIGIDOS', {
        phase: 'TIMESTAMP_CORRECTION_COMPLETE',
        totalSegments: segments.length,
        warningsCount: warnings.length,
        timelineSpan: segments.length > 0 ? `${segments[0]?.start?.toFixed(2)}s - ${segments[segments.length-1]?.end?.toFixed(2)}s` : 'N/A'
      });

      const fullText = segments.map(s => s.text).join(' ');
      // Validação final rigorosa
      if (segments.length === 0) {
        throw new Error('FALHA CRÍTICA: Nenhum segmento final foi gerado');
      }

      const job: TranscriptionJob = {
        id: jobId,
        status: 'completed', // Sempre 'completed' pois garantimos 100% de sucesso
        speedFactor: effectiveSpeedFactor,
        chunkLengthS: maxChunkDuration || Math.min(config.audio.chunkTime, originalDuration),
        sourceDurationS: originalDuration, // CORREÇÃO: Usar duração original do arquivo fonte
        processedChunks: metrics.chunksProcessed,
        failedChunks: [], // Garantido vazio pois temos 100% sucesso
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

      // Validação final absoluta antes de marcar como concluído
      const finalValidation = {
        allChunksProcessed: chunkResults.length === chunks.length,
        allChunksSuccessful: chunkResults.every((r: ChunkResult) => r.success),
        segmentsGenerated: segments.length > 0,
        textGenerated: fullText.length > 0,
        jobStatus: job.status === 'completed'
      };

      const validationPassed = Object.values(finalValidation).every(v => v === true);

      if (!validationPassed) {
        throw new Error(`VALIDAÇÃO FINAL FALHOU: ${JSON.stringify(finalValidation)}`);
      }

      jobLogger.info('🎉 ✅ JOB 100% CONCLUÍDO COM SUCESSO TOTAL! 🎉', {
        phase: 'JOB_COMPLETE_VALIDATED',
        jobId,
        status: job.status,
        finalValidation: finalValidation,
        finalStats: processingStats,
        guarantees: {
          chunksProcessed: '100%',
          transcriptionSuccess: '100%',
          segmentsGenerated: segments.length,
          charactersGenerated: fullText.length
        },
        warnings: warnings.length > 0 ? warnings : 'Nenhum aviso',
        timestamp: new Date().toISOString(),
        certification: '✅ SUCESSO TOTAL CERTIFICADO'
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
    let segmentIndex = 1;
    let lastEndTime = 0;

    // Ordenar chunks por índice para garantir sequência correta
    const sortedResults = chunkResults.sort((a, b) => a.chunkIndex - b.chunkIndex);

    for (let i = 0; i < sortedResults.length; i++) {
      const result = sortedResults[i];
      if (!result) continue; // Skip undefined results

      const chunkStartTime = result.chunkStartTime;

      // VALIDAÇÃO DE CONTINUIDADE: Verificar se há gap ou sobreposição
      if (i > 0) {
        const gap = chunkStartTime - lastEndTime;
        if (Math.abs(gap) > 1) { // Tolerância de 1s
          const gapType = gap > 0 ? 'GAP' : 'OVERLAP';
          logger.warn(`⚠️ ${gapType} detectado entre chunks`, {
            chunkIndex: result.chunkIndex,
            expectedStart: lastEndTime.toFixed(2),
            actualStart: chunkStartTime.toFixed(2),
            difference: `${Math.abs(gap).toFixed(2)}s`,
            impact: gapType === 'GAP' ? 'Possível áudio perdido' : 'Possível duplicação'
          });
          warnings.push(`${gapType}: ${Math.abs(gap).toFixed(1)}s between chunks ${i} and ${i+1}`);
        }
      }

      if (result.success && result.segments) {
        for (const segment of result.segments) {
          const correctedSegment: TranscriptionSegment = {
            index: segmentIndex++,
            // CORREÇÃO FINAL: Whisper retorna timestamps do áudio acelerado
            // Como chunkStartTime já está na timeline original, só desaceleramos e somamos
            start: (segment.start * speedFactor) + chunkStartTime,
            end: (segment.end * speedFactor) + chunkStartTime,
            text: segment.text.trim()
          };

          if (correctedSegment.text) {
            // DETECTOR DE REPETIÇÕES: Verificar se o texto é idêntico aos últimos 3 segmentos
            const isConsecutiveDuplicate = segments.length >= 1 &&
              segments.slice(-3).some(lastSeg => lastSeg.text === correctedSegment.text);

            if (isConsecutiveDuplicate) {
              logger.warn('🚨 REPETIÇÃO CONSECUTIVA DETECTADA - Pulando segmento duplicado', {
                chunkIndex: result.chunkIndex,
                duplicatedText: correctedSegment.text.substring(0, 50) + '...',
                originalTimestamp: `${correctedSegment.start.toFixed(2)}s-${correctedSegment.end.toFixed(2)}s`,
                previousSegments: segments.slice(-2).map(s => ({
                  text: s.text.substring(0, 30) + '...',
                  timestamp: `${s.start.toFixed(2)}s-${s.end.toFixed(2)}s`
                })),
                action: 'Segment filtrado - possível alucinação do Whisper'
              });

              // Continuar processamento, mas pular este segmento duplicado
              segmentIndex--; // Reverter o incremento do índice
              continue;
            }

            segments.push(correctedSegment);
            lastEndTime = Math.max(lastEndTime, correctedSegment.end);
          }
        }

        // LOG DE VALIDAÇÃO DETALHADO
        if (result.segments.length > 0) {
          const firstSegment = result.segments[0];
          const lastSegment = result.segments[result.segments.length - 1];
          if (firstSegment && lastSegment) {
            logger.info('🎯 Chunk processado com timestamps validados', {
              chunkIndex: result.chunkIndex,
              chunkStartTime: `${chunkStartTime.toFixed(2)}s`,
              segmentsInChunk: result.segments.length,
              whisperRange: `${firstSegment.start.toFixed(2)}s-${lastSegment.end.toFixed(2)}s (acelerado)`,
              correctedRange: `${((firstSegment.start * speedFactor) + chunkStartTime).toFixed(2)}s-${((lastSegment.end * speedFactor) + chunkStartTime).toFixed(2)}s`,
              speedFactor,
              continuityCheck: i > 0 ? `Continuous timeline` : 'First chunk'
            });
          }
        }
      } else {
        // CORREÇÃO CRÍTICA: Usar a duração real do chunk que falhou
        const actualChunkDuration = result.chunkDuration;
        lastEndTime = Math.max(lastEndTime, chunkStartTime + actualChunkDuration);

        const chunkName = path.basename(result.chunkPath);
        const warning = `${chunkName} (${chunkStartTime.toFixed(2)}s-${(chunkStartTime + actualChunkDuration).toFixed(2)}s): ${result.error || 'transcription failed'}`;
        warnings.push(warning);

        logger.error('🚨 Chunk com falha - timeline precisa estimada', {
          chunkIndex: result.chunkIndex,
          chunkPath: result.chunkPath,
          actualRange: `${chunkStartTime.toFixed(2)}s-${(chunkStartTime + actualChunkDuration).toFixed(2)}s`,
          chunkDuration: `${actualChunkDuration.toFixed(2)}s`,
          error: result.error,
          impact: `${actualChunkDuration.toFixed(2)}s de áudio sem transcrição (duração exata)`
        });
      }
    }

    // VALIDAÇÃO FINAL RIGOROSA DA TIMELINE
    const lastResult = sortedResults[sortedResults.length - 1];
    const totalExpectedDuration = lastResult ? lastResult.chunkStartTime + lastResult.chunkDuration : 0;
    const timelineDiscrepancy = Math.abs(lastEndTime - totalExpectedDuration);
    const MAX_ACCEPTABLE_GAP = 60; // 60 segundos de tolerância

    // CALCULAR MÉTRICAS DE QUALIDADE LOCALMENTE
    const failedChunks = sortedResults.filter((r: ChunkResult) => !r.success).length;
    const totalChunks = sortedResults.length;
    const failureRate = totalChunks > 0 ? (failedChunks / totalChunks) : 0;

    // VALIDAÇÃO CRÍTICA: Detectar problemas graves de timeline
    const hasSignificantGaps = timelineDiscrepancy > MAX_ACCEPTABLE_GAP;
    const hasLowSegmentDensity = segments.length < (totalExpectedDuration / 60); // Menos de 1 segmento por minuto
    const hasHighFailureRate = failureRate > 0.3; // Mais de 30% de falhas

    if (hasSignificantGaps || hasLowSegmentDensity || hasHighFailureRate) {
      logger.error('🚨 TRANSCRIÇÃO COMPROMETIDA DETECTADA', {
        timelineDiscrepancy: `${timelineDiscrepancy.toFixed(2)}s`,
        segmentDensity: `${(segments.length / (totalExpectedDuration / 60)).toFixed(1)} seg/min`,
        failureRate: `${(failureRate * 100).toFixed(1)}%`,
        failedChunks,
        totalChunks,
        hasSignificantGaps,
        hasLowSegmentDensity,
        hasHighFailureRate,
        recommendation: 'Transcrição pode estar corrompida - investigar arquivo de origem'
      });

      warnings.push(`QUALITY_ALERT: Transcription quality may be compromised (${timelineDiscrepancy.toFixed(1)}s gap, ${(failureRate * 100).toFixed(1)}% failures)`);
    }

    logger.info('📊 Timeline final validada', {
      totalSegments: segments.length,
      finalTimestamp: lastEndTime.toFixed(2),
      expectedDuration: totalExpectedDuration.toFixed(2),
      timelineDiscrepancy: `${timelineDiscrepancy.toFixed(2)}s`,
      segmentDensity: `${(segments.length / Math.max(1, totalExpectedDuration / 60)).toFixed(1)} seg/min`,
      failureRate: `${(failureRate * 100).toFixed(1)}%`,
      failedChunks,
      totalChunks,
      timelineIntegrity: hasSignificantGaps || hasLowSegmentDensity || hasHighFailureRate ? '⚠️ COMPROMETIDA' : '✅ ÍNTEGRA',
      warningsCount: warnings.length,
      qualityAssurance: hasSignificantGaps || hasLowSegmentDensity || hasHighFailureRate ? '🚨 NEEDS_REVIEW' : '✅ PASSED'
    });

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
