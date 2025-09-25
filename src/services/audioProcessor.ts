import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { AudioChunk, SilenceSegment, SmartChunkPlan } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface ValidationResult {
  isValid: boolean;
  error?: string;
  expectedDuration: number;
  actualDuration: number;
  accuracyPercent: number;
}

export class AudioProcessor {
  private tempDir: string;
  private chunkDir: string;
  private readonly speedFactor: number;

  constructor(jobId: string, speedFactor: number) {
    this.speedFactor = speedFactor;
    this.tempDir = path.join(config.directories.temp, `job_${jobId}`);
    this.chunkDir = path.join(this.tempDir, `temp_audio_chunks_${this.speedFactor}x`);

    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    if (!fs.existsSync(this.chunkDir)) {
      fs.mkdirSync(this.chunkDir, { recursive: true });
    }
  }

  async processAudio(inputPath: string): Promise<{ processedPath: string; duration: number; originalDuration: number; originalSizeBytes: number }> {
    const processedPath = path.join(this.chunkDir, 'processed_audio.wav');
    const sourceStats = fs.statSync(inputPath);
    const originalSizeBytes = sourceStats.size;


    logger.info('🎧 Iniciando processamento de áudio', {
      inputPath: path.basename(inputPath),
      processedPath: path.basename(processedPath),
      speedFactor: this.speedFactor,
      codec: 'pcm_s16le (WAV) - apenas aceleração'
    });

    return new Promise((resolve, reject) => {
      let originalDuration = 0;

      ffmpeg(inputPath)
        .audioFilters(`atempo=${this.speedFactor}`)
        .audioCodec('pcm_s16le')
        .format('wav')
        .on('codecData', (data) => {
          // CORREÇÃO: data.duration é a duração do arquivo de ENTRADA original
          originalDuration = this.parseDuration(data.duration);
          const expectedAcceleratedDuration = originalDuration / this.speedFactor;

          // Validação: detectar possível conteúdo duplicado
          const suspiciouslyLong = originalDuration > 7200; // > 2 horas
          const possibleDuplication = originalDuration > 3600 && (originalDuration % 1800 < 60 || originalDuration % 1937 < 60);

          logger.info('📊 Informações do áudio detectadas', {
            originalDuration: `${originalDuration.toFixed(2)}s`,
            estimatedAcceleratedDuration: `${expectedAcceleratedDuration.toFixed(2)}s`,
            format: data.format,
            codec: data.audio_details || 'N/A',
            speedFactor: this.speedFactor,
            ...(suspiciouslyLong && { warning: '⚠️ Áudio muito longo - possível duplicação' }),
            ...(possibleDuplication && { alert: '🚨 Possível conteúdo duplicado detectado' })
          });

          // Log extra para debug em casos suspeitos
          if (suspiciouslyLong || possibleDuplication) {
            logger.warn('🔍 Análise de possível duplicação', {
              originalDurationMinutes: (originalDuration / 60).toFixed(1),
              suspiciouslyLong,
              possibleDuplication,
              inputFile: path.basename(inputPath),
              recommendation: 'Verificar arquivo de origem para conteúdo duplicado'
            });
          }
        })
        .on('progress', (progress) => {
          if (progress.percent && progress.percent % 25 === 0) {
            logger.info('⚡ Progresso do processamento', {
              percent: `${progress.percent?.toFixed(1)}%`,
              currentTime: progress.timemark,
              phase: 'Audio acceleration (lossless)'
            });
          }
        })
        .on('end', async () => {
          // VALIDAÇÃO CRÍTICA: Verificar se o arquivo processado não está corrompido
          try {
            const validationResult = await this.validateProcessedAudio(processedPath, originalDuration, this.speedFactor);

            if (!validationResult.isValid) {
              reject(new Error(`Audio processing validation failed: ${validationResult.error}`));
              return;
            }

            logger.info('✅ Áudio processado e validado com sucesso', {
              processedPath: path.basename(processedPath),
              actualAcceleratedDuration: `${validationResult.actualDuration.toFixed(2)}s`,
              originalDuration: `${originalDuration.toFixed(2)}s`,
              expectedAcceleratedDuration: `${validationResult.expectedDuration.toFixed(2)}s`,
              durationAccuracy: `${validationResult.accuracyPercent.toFixed(1)}%`,
              processingPipeline: 'Lossless acceleration -> chunked MP3',
              validation: '✅ PASSED',
              nextPhase: 'Chunking'
            });

            resolve({
              processedPath,
              duration: validationResult.actualDuration, // Duração real do arquivo processado
              originalDuration: originalDuration, // Duração original correta
              originalSizeBytes
            });
          } catch (validationError) {
            const errorMsg = validationError instanceof Error ? validationError.message : 'Unknown validation error';
            logger.error('❌ Falha na validação pós-processamento', {
              processedPath: path.basename(processedPath),
              error: errorMsg,
              phase: 'Audio validation'
            });
            reject(new Error(`Audio validation failed: ${errorMsg}`));
          }
        })
        .on('error', (err) => {
          logger.error('❌ Falha no processamento de áudio', {
            error: err.message,
            inputPath: path.basename(inputPath),
            phase: 'FFmpeg processing'
          });
          reject(new Error(`Audio processing failed: ${err.message}`));
        })
        .save(processedPath);
    });
  }

  async createChunks(processedPath: string, acceleratedDuration: number, originalDuration: number, originalSizeBytes: number): Promise<AudioChunk[]> {
    // Primeiro, detectar silêncios no áudio processado
    logger.info('🔇 FASE 2.1: Detectando silêncios para cortes inteligentes', {
      processedPath: path.basename(processedPath),
      silenceThreshold: `${config.audio.silenceThreshold}dB`,
      silenceDuration: `${config.audio.silenceDuration}s`,
      strategy: 'Cortar apenas em pontos de silêncio natural'
    });

    const silenceSegments = await this.detectSilence(processedPath);

    logger.info('🎵 Silêncios detectados para cortes inteligentes', {
      totalSilences: silenceSegments.length,
      totalSilenceDuration: `${silenceSegments.reduce((sum, s) => sum + s.duration, 0).toFixed(2)}s`,
      avgSilenceDuration: silenceSegments.length > 0 ? `${(silenceSegments.reduce((sum, s) => sum + s.duration, 0) / silenceSegments.length).toFixed(2)}s` : '0s',
      silenceDistribution: this.analyzeSilenceDistribution(silenceSegments, originalDuration)
    });

    return this.createSmartChunks(processedPath, acceleratedDuration, originalDuration, originalSizeBytes, silenceSegments);
  }

  private async detectSilence(audioPath: string): Promise<SilenceSegment[]> {
    return new Promise((resolve, reject) => {
      const silences: SilenceSegment[] = [];

      ffmpeg(audioPath)
        .audioFilters(`silencedetect=n=${config.audio.silenceThreshold}dB:d=${config.audio.silenceDuration}`)
        .format('null')
        .on('stderr', (stderrLine) => {
          // Parse silence detection output
          const silenceStartMatch = stderrLine.match(/silence_start: ([\d.]+)/);
          const silenceEndMatch = stderrLine.match(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/);

          if (silenceStartMatch && silenceEndMatch) {
            const start = parseFloat(silenceStartMatch[1] || '0');
            const end = parseFloat(silenceEndMatch[1] || '0');
            const duration = parseFloat(silenceEndMatch[2] || '0');

            silences.push({
              start: start,
              end: end,
              duration: duration
            });
          }
        })
        .on('end', () => {
          // Sort silences by start time
          silences.sort((a, b) => a.start - b.start);
          resolve(silences);
        })
        .on('error', (err) => {
          logger.warn('⚠️ Falha na detecção de silêncio, usando cortes tradicionais', {
            error: err.message,
            fallback: 'Cortes por tempo exato'
          });
          resolve([]); // Return empty array to fallback to traditional cutting
        })
        .output('-')
        .run();
    });
  }

  private analyzeSilenceDistribution(silences: SilenceSegment[], totalDuration: number): string {
    if (silences.length === 0) return 'Nenhum silêncio detectado';

    const intervals = Math.ceil(totalDuration / 300); // 5min intervals
    const distribution = new Array(intervals).fill(0);

    silences.forEach(silence => {
      const intervalIndex = Math.floor(silence.start / 300);
      if (intervalIndex < intervals) {
        distribution[intervalIndex]++;
      }
    });

    return `${distribution.join(',')} por 5min`;
  }

  private async createSmartChunks(processedPath: string, acceleratedDuration: number, originalDuration: number, originalSizeBytes: number, silences: SilenceSegment[]): Promise<AudioChunk[]> {
    const chunks: AudioChunk[] = [];
    const maxChunkBytes = 18 * 1024 * 1024; // 18MB limit
    const maxChunkDurationMinutes = 20; // 20min limit
    const maxChunkDurationSecondsAccelerated = maxChunkDurationMinutes * 60;
    const speedFactor = this.speedFactor;
    const silenceWindow = config.audio.silenceWindow;
    const minChunkDuration = config.audio.minChunkDuration;

    const safeOriginalDuration = originalDuration > 0 ? originalDuration : 1;

    // Calculate chunk limits based on accelerated content
    const acceleratedBytesEstimate = originalSizeBytes;
    const acceleratedDurationTotal = safeOriginalDuration / speedFactor;
    const estimatedBytesPerSecondAccelerated = acceleratedBytesEstimate / acceleratedDurationTotal;

    // Minimum chunks needed to stay under limits
    const minChunksBySize = Math.max(1, Math.ceil(acceleratedBytesEstimate / maxChunkBytes));
    const minChunksByDuration = Math.max(1, Math.ceil(acceleratedDurationTotal / maxChunkDurationSecondsAccelerated));
    const totalChunksNeeded = Math.max(minChunksByDuration, minChunksBySize);

    // Calculate ideal chunk duration (in original timeline)
    const idealChunkDurationOriginal = safeOriginalDuration / totalChunksNeeded;

    logger.info('🎯 Planejamento inteligente de chunks com snap-to-silence', {
      originalDuration: `${originalDuration.toFixed(2)}s`,
      acceleratedDuration: `${acceleratedDuration.toFixed(2)}s`,
      limits: {
        maxSizeMB: 18,
        maxDurationMin: 20,
        speedFactor: `${speedFactor}x`
      },
      silenceConfig: {
        totalSilences: silences.length,
        silenceWindow: `±${silenceWindow}s`,
        minChunkDuration: `${minChunkDuration}s`
      },
      planning: {
        minChunksBySize,
        minChunksByDuration,
        totalChunksNeeded,
        idealChunkDuration: `${idealChunkDurationOriginal.toFixed(2)}s`
      },
      strategy: 'Snap-to-silence dentro da janela configurada'
    });

    // Create chunk plans with silence-based cutting
    const chunkPlans = this.planSilenceBasedChunks(
      safeOriginalDuration,
      idealChunkDurationOriginal,
      silences,
      silenceWindow,
      minChunkDuration,
      estimatedBytesPerSecondAccelerated
    );

    const totalPlannedDuration = chunkPlans.reduce((sum, p) => sum + p.duration, 0);
    const lastPlan = chunkPlans[chunkPlans.length - 1];

    logger.info('📋 Planos de chunk calculados', {
      totalPlans: chunkPlans.length,
      silenceUsage: chunkPlans.filter(p => p.usedSilence).length,
      exactCuts: chunkPlans.filter(p => !p.usedSilence).length,
      avgChunkDuration: `${(totalPlannedDuration / chunkPlans.length).toFixed(2)}s`,
      totalPlannedDuration: `${totalPlannedDuration.toFixed(2)}s`,
      originalDuration: `${safeOriginalDuration.toFixed(2)}s`,
      lastChunkEnd: lastPlan ? `${(lastPlan.actualStart + lastPlan.duration).toFixed(2)}s` : 'N/A',
      coverage: `${((totalPlannedDuration / safeOriginalDuration) * 100).toFixed(1)}%`
    });

    // Execute chunk creation based on plans
    for (const plan of chunkPlans) {
      const chunkPath = path.join(this.chunkDir, `chunk_${String(plan.index + 1).padStart(3, '0')}.mp3`);

      // Convert to accelerated timeline for cutting
      const acceleratedStartTime = plan.actualStart / speedFactor;
      const acceleratedDuration = plan.duration / speedFactor;

      await this.createChunk(processedPath, chunkPath, acceleratedStartTime, acceleratedDuration);

      const chunkSizeBytes = fs.existsSync(chunkPath) ? fs.statSync(chunkPath).size : 0;

      // Validate chunk meets size constraints
      if (chunkSizeBytes > maxChunkBytes) {
        logger.error('💥 CHUNK EXCEDE LIMITE DE 18MB', {
          chunkIndex: plan.index,
          actualSizeMB: (chunkSizeBytes / (1024 * 1024)).toFixed(2),
          maxSizeMB: 18,
          chunkPath: path.basename(chunkPath),
          action: 'FALHA CRÍTICA - Chunk muito grande'
        });
        throw new Error(`Chunk ${plan.index} exceeds 18MB limit: ${(chunkSizeBytes / (1024 * 1024)).toFixed(2)}MB`);
      }

      logger.info(
        plan.usedSilence ? '✂️ 🔇' : '✂️ ⏱️',
        {
          chunkIndex: `${plan.index + 1}/${chunkPlans.length}`,
          cutType: plan.usedSilence ? 'SILENCE-CUT' : 'EXACT-CUT',
          originalTimeRange: `${plan.actualStart.toFixed(2)}s - ${(plan.actualStart + plan.duration).toFixed(2)}s`,
          duration: `${plan.duration.toFixed(2)}s`,
          sizeMB: `${(chunkSizeBytes / (1024 * 1024)).toFixed(2)}MB`,
          ...(plan.usedSilence && {
            silenceUsed: `${plan.silenceStart?.toFixed(2)}s - ${plan.silenceEnd?.toFixed(2)}s`,
            adjustment: `Target: ${plan.targetEnd.toFixed(2)}s → Actual: ${plan.actualEnd.toFixed(2)}s`
          })
        }
      );

      chunks.push({
        index: plan.index,
        path: chunkPath,
        duration: plan.duration,
        startTime: plan.actualStart
      });
    }

    logger.info('🎊 Chunks criados com sucesso usando snap-to-silence', {
      totalChunks: chunks.length,
      totalDuration: `${chunks.reduce((sum, c) => sum + c.duration, 0).toFixed(2)}s`,
      originalDuration: `${originalDuration.toFixed(2)}s`,
      silenceBasedCuts: chunkPlans.filter(p => p.usedSilence).length,
      exactCuts: chunkPlans.filter(p => !p.usedSilence).length,
      averageChunkSize: `${(chunks.reduce((sum, c) => fs.statSync(c.path).size, 0) / chunks.length / (1024 * 1024)).toFixed(2)}MB`,
      allChunksUnder18MB: '✅ VERIFIED'
    });

    return chunks;
  }

  private planSilenceBasedChunks(
    totalDuration: number,
    idealChunkDuration: number,
    silences: SilenceSegment[],
    silenceWindow: number,
    minChunkDuration: number,
    estimatedBytesPerSecond: number
  ): SmartChunkPlan[] {
    const plans: SmartChunkPlan[] = [];
    let currentStart = 0;
    let chunkIndex = 0;

    while (currentStart < totalDuration) {
      const remainingDuration = totalDuration - currentStart;
      const targetDuration = Math.min(idealChunkDuration, remainingDuration);
      const targetEnd = currentStart + targetDuration;

      // Find the best silence point within the window
      const windowStart = Math.max(0, targetEnd - silenceWindow);
      const windowEnd = Math.min(totalDuration, targetEnd + silenceWindow);

      const candidateSilences = silences.filter(silence =>
        silence.start >= windowStart && silence.end <= windowEnd
      );

      let actualEnd = targetEnd;
      let usedSilence = false;
      let silenceStart: number | undefined;
      let silenceEnd: number | undefined;

      if (candidateSilences.length > 0) {
        // Find the silence closest to target end
        const bestSilence = candidateSilences.reduce((best, current) => {
          const bestDistance = Math.abs(best.start + best.duration / 2 - targetEnd);
          const currentDistance = Math.abs(current.start + current.duration / 2 - targetEnd);
          return currentDistance < bestDistance ? current : best;
        });

        // Use the middle of the silence as the cut point
        actualEnd = bestSilence.start + bestSilence.duration / 2;
        usedSilence = true;
        silenceStart = bestSilence.start;
        silenceEnd = bestSilence.end;
      }

      const actualDuration = actualEnd - currentStart;

      // Ensure minimum chunk duration but never exceed totalDuration
      if (actualDuration < minChunkDuration && remainingDuration > minChunkDuration) {
        actualEnd = Math.min(currentStart + minChunkDuration, totalDuration);
        usedSilence = false;
        silenceStart = undefined;
        silenceEnd = undefined;
      }

      // CRITICAL: Never let actualEnd exceed totalDuration
      actualEnd = Math.min(actualEnd, totalDuration);
      const finalDuration = actualEnd - currentStart;

      // Skip if this would create a chunk with negligible duration
      if (finalDuration < 0.1) {
        break;
      }
      const estimatedSizeMB = (finalDuration * estimatedBytesPerSecond) / (1024 * 1024);

      const plan: SmartChunkPlan = {
        index: chunkIndex,
        targetStart: currentStart,
        targetEnd: targetEnd,
        actualStart: currentStart,
        actualEnd: actualEnd,
        duration: finalDuration,
        usedSilence: usedSilence,
        estimatedSizeMB: estimatedSizeMB
      };

      if (usedSilence && silenceStart !== undefined && silenceEnd !== undefined) {
        plan.silenceStart = silenceStart;
        plan.silenceEnd = silenceEnd;
      }

      plans.push(plan);

      currentStart = actualEnd;
      chunkIndex++;

      // CRITICAL: Stop if we've reached the end of the audio
      if (currentStart >= totalDuration) {
        break;
      }

      // Safety break to prevent infinite loops
      if (chunkIndex > 1000) {
        logger.warn('⚠️ Muitos chunks planejados, interrompendo', {
          chunkIndex,
          currentStart,
          totalDuration,
          action: 'Finalizando planejamento'
        });
        break;
      }
    }

    return plans;
  }

  private createChunk(inputPath: string, outputPath: string, startTime: number, duration: number): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .seekInput(startTime)
        .duration(duration)
        .audioCodec('libmp3lame')
        .on('end', () => resolve())
        .on('error', (err) => {
          logger.error('❌ Falha na criação do chunk', {
            outputPath: path.basename(outputPath),
            startTime: `${startTime.toFixed(2)}s`,
            duration: `${duration.toFixed(2)}s`,
            error: err.message,
            phase: 'Chunk creation'
          });
          reject(new Error(`Chunk creation failed: ${err.message}`));
        })
        .save(outputPath);
    });
  }

  private parseDuration(durationStr: string): number {
    const parts = durationStr.split(':');
    if (parts.length === 3) {
      const hours = parseInt(parts[0] ?? '0', 10);
      const minutes = parseInt(parts[1] ?? '0', 10);
      const seconds = parseFloat(parts[2] ?? '0');
      return hours * 3600 + minutes * 60 + seconds;
    }
    return 0;
  }

  cleanup(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
        logger.info('🧹 Arquivos temporários limpos', {
          tempDir: path.basename(this.tempDir),
          phase: 'Cleanup completed'
        });
      }
    } catch (error) {
      logger.error('⚠️ Falha na limpeza dos arquivos temporários', {
        tempDir: path.basename(this.tempDir),
        error: error instanceof Error ? error.message : 'Unknown error',
        phase: 'Cleanup failed'
      });
    }
  }

  getTempDir(): string {
    return this.tempDir;
  }

  getChunkDir(): string {
    return this.chunkDir;
  }

  private async validateProcessedAudio(filePath: string, expectedOriginalDuration: number, speedFactor: number): Promise<ValidationResult> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(new Error(`FFprobe validation failed: ${err.message}`));
          return;
        }

        const actualDuration = metadata.format.duration || 0;
        const expectedAcceleratedDuration = expectedOriginalDuration / speedFactor;

        // Calcular precisão
        const durationDiff = Math.abs(actualDuration - expectedAcceleratedDuration);
        const accuracyPercent = Math.max(0, 100 - (durationDiff / expectedAcceleratedDuration) * 100);

        // Validações críticas
        const MAX_DURATION_ERROR_PERCENT = 5; // Tolerância de 5%
        const MIN_ACCURACY = 95;

        let isValid = true;
        let error = '';

        // VALIDAÇÃO 1: Duração não pode estar drasticamente errada
        if (accuracyPercent < MIN_ACCURACY) {
          isValid = false;
          error = `Duration mismatch: expected ${expectedAcceleratedDuration.toFixed(2)}s, got ${actualDuration.toFixed(2)}s (accuracy: ${accuracyPercent.toFixed(1)}%)`;
        }

        // VALIDAÇÃO 2: Detectar duplicação (áudio 2x maior que esperado)
        if (actualDuration > expectedAcceleratedDuration * 1.9) {
          isValid = false;
          error = `Possible audio duplication detected: file is ${(actualDuration / expectedAcceleratedDuration).toFixed(1)}x longer than expected`;
        }

        // VALIDAÇÃO 3: Detectar corrupção (áudio muito pequeno)
        if (actualDuration < expectedAcceleratedDuration * 0.5) {
          isValid = false;
          error = `Possible audio corruption: file is only ${(actualDuration / expectedAcceleratedDuration).toFixed(1)}x the expected duration`;
        }

        // VALIDAÇÃO 4: Verificar se o arquivo existe e tem tamanho > 0
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
          isValid = false;
          error = 'Output file is empty (0 bytes)';
        }

        logger.debug('🔍 Audio validation completed', {
          expectedDuration: expectedAcceleratedDuration.toFixed(2),
          actualDuration: actualDuration.toFixed(2),
          accuracyPercent: accuracyPercent.toFixed(1),
          fileSizeBytes: stats.size,
          isValid,
          error: error || 'No errors'
        });

        resolve({
          isValid,
          error,
          expectedDuration: expectedAcceleratedDuration,
          actualDuration,
          accuracyPercent
        });
      });
    });
  }
}
