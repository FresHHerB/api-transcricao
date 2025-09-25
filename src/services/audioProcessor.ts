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

  constructor(jobId: string) {
    this.tempDir = path.join(config.directories.temp, `job_${jobId}`);
    this.chunkDir = path.join(this.tempDir, `temp_audio_chunks_${config.audio.speedFactor}x`);

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

  async processAudio(inputPath: string): Promise<{ processedPath: string; duration: number; originalDuration: number }> {
    const processedPath = path.join(this.chunkDir, 'processed_audio.ogg');

    logger.info('🎧 Iniciando processamento de áudio', {
      inputPath: path.basename(inputPath),
      processedPath: path.basename(processedPath),
      speedFactor: config.audio.speedFactor,
      quality: config.audio.quality,
      codec: 'libvorbis (OGG)'
    });

    return new Promise((resolve, reject) => {
      let duration = 0;

      ffmpeg(inputPath)
        .audioFilters(`atempo=${config.audio.speedFactor}`)
        .audioCodec('libvorbis')
        .audioQuality(config.audio.quality)
        .on('codecData', (data) => {
          duration = this.parseDuration(data.duration);
          const originalDuration = duration / config.audio.speedFactor;

          // Validação: detectar possível conteúdo duplicado
          const suspiciouslyLong = originalDuration > 7200; // > 2 horas
          const possibleDuplication = originalDuration > 3600 && (originalDuration % 1800 < 60 || originalDuration % 1937 < 60);

          logger.info('📊 Informações do áudio detectadas', {
            duration: `${duration.toFixed(2)}s`,
            format: data.format,
            estimatedOriginalDuration: `${originalDuration.toFixed(2)}s`,
            codec: data.audio_details || 'N/A',
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
              phase: 'Audio acceleration + compression'
            });
          }
        })
        .on('end', async () => {
          const originalDuration = duration / config.audio.speedFactor;

          // VALIDAÇÃO CRÍTICA: Verificar se o arquivo processado não está corrompido
          try {
            const validationResult = await this.validateProcessedAudio(processedPath, originalDuration, config.audio.speedFactor);

            if (!validationResult.isValid) {
              reject(new Error(`Audio processing validation failed: ${validationResult.error}`));
              return;
            }

            logger.info('✅ Áudio processado e validado com sucesso', {
              processedPath: path.basename(processedPath),
              acceleratedDuration: `${duration.toFixed(2)}s`,
              originalDuration: `${originalDuration.toFixed(2)}s`,
              expectedAcceleratedDuration: `${validationResult.expectedDuration.toFixed(2)}s`,
              durationAccuracy: `${validationResult.accuracyPercent.toFixed(1)}%`,
              compression: `${config.audio.speedFactor}x faster`,
              validation: '✅ PASSED',
              nextPhase: 'Chunking'
            });

            resolve({
              processedPath,
              duration: duration,
              originalDuration: originalDuration
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

  async createChunks(processedPath: string, acceleratedDuration: number, originalDuration: number): Promise<AudioChunk[]> {
    const chunks: AudioChunk[] = [];
    const chunkDuration = config.audio.chunkTime;
    const totalChunks = Math.ceil(originalDuration / chunkDuration);

    logger.info('🔪 Iniciando divisão em chunks', {
      originalDuration: `${originalDuration.toFixed(2)}s`,
      acceleratedDuration: `${acceleratedDuration.toFixed(2)}s`,
      chunkDuration: `${chunkDuration}s`,
      totalChunks,
      estimatedChunkSizes: `~${chunkDuration}s each (original timeline)`,
      processingStrategy: 'Chunks baseados na timeline original, arquivo físico acelerado'
    });

    for (let i = 0; i < totalChunks; i++) {
      // CORREÇÃO: startTime na timeline ORIGINAL
      const originalStartTime = i * chunkDuration;
      const originalChunkDuration = Math.min(chunkDuration, originalDuration - originalStartTime);

      // Converter para coordenadas do arquivo acelerado para o FFmpeg
      const acceleratedStartTime = originalStartTime / config.audio.speedFactor;
      const acceleratedChunkDuration = originalChunkDuration / config.audio.speedFactor;

      const chunkPath = path.join(this.chunkDir, `chunk_${String(i + 1).padStart(3, '0')}.mp3`);

      await this.createChunk(processedPath, chunkPath, acceleratedStartTime, acceleratedChunkDuration);

      chunks.push({
        index: i + 1,
        path: chunkPath,
        duration: originalChunkDuration, // Duração na timeline original
        startTime: originalStartTime    // Tempo de início na timeline original
      });

      logger.info('📦 Chunk criado', {
        chunkNumber: `${i + 1}/${totalChunks}`,
        chunkPath: path.basename(chunkPath),
        originalRange: `${originalStartTime.toFixed(2)}s-${(originalStartTime + originalChunkDuration).toFixed(2)}s`,
        acceleratedRange: `${acceleratedStartTime.toFixed(2)}s-${(acceleratedStartTime + acceleratedChunkDuration).toFixed(2)}s`,
        progress: `${(((i + 1) / totalChunks) * 100).toFixed(1)}%`
      });
    }

    logger.info('🎯 TODOS OS CHUNKS CRIADOS!', {
      totalChunks: chunks.length,
      originalTotalSize: `${originalDuration.toFixed(2)}s`,
      acceleratedTotalSize: `${acceleratedDuration.toFixed(2)}s`,
      averageOriginalChunkSize: `${(originalDuration / chunks.length).toFixed(2)}s`,
      nextPhase: 'Enviando para OpenAI Whisper API',
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
        .audioQuality(2)
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