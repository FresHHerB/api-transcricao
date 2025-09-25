import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { AudioChunk } from '../types';
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
    const chunks: AudioChunk[] = [];
    const maxChunkBytes = 18 * 1024 * 1024; // 18MB limit
    const maxChunkDurationMinutes = 20; // 20min limit
    const maxChunkDurationSecondsAccelerated = maxChunkDurationMinutes * 60;
    const speedFactor = this.speedFactor;

    const safeOriginalDuration = originalDuration > 0 ? originalDuration : 1;

    // Calculate chunk limits based on accelerated content
    const acceleratedBytesEstimate = originalSizeBytes; // MP3 size doesn't change much with speed
    const acceleratedDurationTotal = safeOriginalDuration / speedFactor;

    // Minimum chunks needed to stay under 20MB limit
    const estimatedBytesPerSecondAccelerated = acceleratedBytesEstimate / acceleratedDurationTotal;
    const maxAcceleratedChunkSize = maxChunkBytes;
    const minChunksBySize = Math.max(1, Math.ceil(acceleratedBytesEstimate / maxAcceleratedChunkSize));

    // Minimum chunks needed to stay under 15min limit (after acceleration)
    const minChunksByDuration = Math.max(1, Math.ceil(acceleratedDurationTotal / maxChunkDurationSecondsAccelerated));

    const totalChunksNeeded = Math.max(minChunksByDuration, minChunksBySize);
    const chunkDurationOriginalTimeline = Math.max(1, safeOriginalDuration / totalChunksNeeded);

    const totalChunks = Math.max(1, Math.ceil(safeOriginalDuration / chunkDurationOriginalTimeline));

    logger.info('🔪 Iniciando divisão em chunks - Limites: 18MB E 20min', {
      originalDuration: `${originalDuration.toFixed(2)}s`,
      acceleratedDuration: `${acceleratedDuration.toFixed(2)}s`,
      limits: {
        maxSizeMB: 18,
        maxDurationMin: 20,
        speedFactor: `${speedFactor}x`
      },
      calculation: {
        minChunksBySize: minChunksBySize,
        minChunksByDuration: minChunksByDuration,
        totalChunksNeeded: totalChunksNeeded,
        plannedChunks: totalChunks
      },
      estimatedChunkDuration: {
        originalTimeline: `${chunkDurationOriginalTimeline.toFixed(2)}s`,
        acceleratedTimeline: `${(chunkDurationOriginalTimeline / speedFactor).toFixed(2)}s`
      },
      strategy: 'Satisfaz AMBOS os limites: 18MB E 20min'
    });

    let chunkIndex = 0;
    let originalStartTime = 0;

    while (originalStartTime < originalDuration) {
      const remainingDuration = originalDuration - originalStartTime;
      if (remainingDuration <= 0) {
        break;
      }

      let attemptDuration = Math.min(chunkDurationOriginalTimeline, remainingDuration);
      const acceleratedStartTime = originalStartTime / speedFactor;
      let acceleratedChunkDuration = Math.max(attemptDuration / speedFactor, 0.001);
      const chunkPath = path.join(this.chunkDir, `chunk_${String(chunkIndex + 1).padStart(3, '0')}.mp3`);

      let chunkSizeBytes = 0;
      let attempts = 0;

      while (true) {
        await this.createChunk(processedPath, chunkPath, acceleratedStartTime, acceleratedChunkDuration);

        chunkSizeBytes = fs.existsSync(chunkPath) ? fs.statSync(chunkPath).size : 0;
        if (chunkSizeBytes <= maxChunkBytes || attemptDuration <= 1) {
          break;
        }

        if (fs.existsSync(chunkPath)) {
          fs.unlinkSync(chunkPath);
        }
        const previousDuration = attemptDuration;
        attemptDuration = Math.max(previousDuration / 2, 1);
        acceleratedChunkDuration = Math.max(attemptDuration / speedFactor, 0.001);
        attempts += 1;

        logger.warn('⚠️ Chunk acima do limite de 18MB - reparticionando', {
          chunk: `${chunkIndex + 1}/${totalChunks}`,
          size: {
            currentMB: (chunkSizeBytes / (1024 * 1024)).toFixed(2),
            limitMB: 18
          },
          duration: {
            previous: `${previousDuration.toFixed(2)}s`,
            new: `${attemptDuration.toFixed(2)}s`
          },
          attempts,
          action: 'Reduzindo duração do chunk'
        });
      }

      const chunkSizeMB = chunkSizeBytes / (1024 * 1024);

      if (chunkSizeBytes > maxChunkBytes) {
        logger.error('🚨 CHUNK EXCEDE LIMITE - NÃO FOI POSSÍVEL REDUZIR', {
          chunk: `${chunkIndex + 1}/${totalChunks}`,
          finalSize: {
            sizeMB: chunkSizeMB.toFixed(2),
            limitMB: 18,
            excess: `${(chunkSizeMB - 18).toFixed(2)}MB acima`
          },
          duration: `${attemptDuration.toFixed(2)}s`,
          status: 'LIMITE VIOLADO - Prosseguindo com chunk grande'
        });
      }

      chunks.push({
        index: chunkIndex + 1,
        path: chunkPath,
        duration: attemptDuration,
        startTime: originalStartTime
      });

      const progress = Math.round((chunkIndex + 1) / totalChunks * 100);
      const sizeStatus = chunkSizeMB <= 18 ? '✅' : '🚨';
      const durationAccelerated = attemptDuration / speedFactor;
      const durationStatus = durationAccelerated <= (20 * 60) ? '✅' : '🚨';

      logger.info(`📦 Chunk ${chunkIndex + 1}/${totalChunks} criado [${progress}%]`, {
        file: path.basename(chunkPath),
        validation: {
          size: `${sizeStatus} ${chunkSizeMB.toFixed(2)}MB/${18}MB`,
          duration: `${durationStatus} ${(durationAccelerated / 60).toFixed(1)}min/20min`
        },
        timeline: {
          original: `${originalStartTime.toFixed(2)}s-${(originalStartTime + attemptDuration).toFixed(2)}s`,
          accelerated: `${acceleratedStartTime.toFixed(2)}s-${(acceleratedStartTime + acceleratedChunkDuration).toFixed(2)}s`
        },
        processing: {
          repartitionAttempts: attempts,
          status: chunkSizeMB <= 18 && durationAccelerated <= (20 * 60) ? 'CONFORME' : 'LIMITE VIOLADO'
        }
      });

      originalStartTime += attemptDuration;
      chunkIndex += 1;
    }

    // Validação final de todos os chunks
    const chunkValidation = chunks.map(chunk => {
      const chunkStats = fs.existsSync(chunk.path) ? fs.statSync(chunk.path) : null;
      const chunkSizeMB = chunkStats ? chunkStats.size / (1024 * 1024) : 0;
      const acceleratedDuration = chunk.duration / speedFactor;

      return {
        index: chunk.index,
        sizeValid: chunkSizeMB <= 18,
        durationValid: acceleratedDuration <= (20 * 60),
        sizeMB: chunkSizeMB,
        durationMin: acceleratedDuration / 60
      };
    });

    const validChunks = chunkValidation.filter(c => c.sizeValid && c.durationValid).length;
    const invalidChunks = chunks.length - validChunks;

    logger.info('🎯 CHUNKING FINALIZADO - Resumo da Validação', {
      summary: {
        totalChunks: chunks.length,
        validChunks: validChunks,
        invalidChunks: invalidChunks,
        successRate: `${Math.round(validChunks / chunks.length * 100)}%`
      },
      limits: {
        maxSizeMB: 18,
        maxDurationMin: 20,
        speedFactor: `${speedFactor}x`
      },
      timeline: {
        originalDuration: `${originalDuration.toFixed(2)}s`,
        acceleratedDuration: `${acceleratedDuration.toFixed(2)}s`,
        averageChunkDuration: chunks.length ? `${(originalDuration / chunks.length).toFixed(2)}s` : '0s'
      },
      status: invalidChunks === 0 ? '✅ TODOS OS CHUNKS CONFORMES' : `⚠️ ${invalidChunks} CHUNKS VIOLAM LIMITES`,
      readyForTranscription: true
    });

    return chunks;
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
