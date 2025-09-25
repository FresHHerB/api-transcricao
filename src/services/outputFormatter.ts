import fs from 'fs';
import path from 'path';
import { config } from '../config/env';
import { TranscriptionSegment } from '../types';
import { logger } from '../utils/logger';

export class OutputFormatter {
  private outputDir: string;
  private speedFactor: number;

  constructor(jobId: string, speedFactor: number = 1.5) {
    this.outputDir = path.join(config.directories.output, jobId);
    this.speedFactor = speedFactor;
    this.ensureOutputDirectory();
  }

  private ensureOutputDirectory(): void {
    if (!fs.existsSync(config.directories.output)) {
      fs.mkdirSync(config.directories.output, { recursive: true });
    }
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async generateSRT(segments: TranscriptionSegment[], jobId: string): Promise<string> {
    const srtPath = path.join(this.outputDir, `transcript_${this.speedFactor}x.srt`);

    logger.info('🎥 Gerando arquivo SRT', {
      srtPath: path.basename(srtPath),
      segments: segments.length,
      estimatedSize: `${segments.length * 4} linhas`
    });

    const srtContent = segments.map((segment) => {
      const startTime = this.formatSRTTime(segment.start);
      const endTime = this.formatSRTTime(segment.end);

      return `${segment.index}\n${startTime} --> ${endTime}\n${segment.text}\n`;
    }).join('\n');

    fs.writeFileSync(srtPath, srtContent, 'utf8');

    logger.info('✅ Arquivo SRT criado', {
      srtPath: path.basename(srtPath),
      fileSize: `${(srtContent.length / 1024).toFixed(2)}KB`,
      segments: segments.length,
      duration: segments.length > 0 ? `${segments[segments.length-1]?.end?.toFixed(2)}s` : '0s'
    });
    return srtPath;
  }

  async generateTXT(fullText: string, jobId: string): Promise<string> {
    const txtPath = path.join(this.outputDir, `transcript_${this.speedFactor}x.txt`);

    logger.info('📄 Gerando arquivo TXT', {
      txtPath: path.basename(txtPath),
      characters: fullText.length,
      words: fullText.split(' ').length
    });

    fs.writeFileSync(txtPath, fullText, 'utf8');

    logger.info('✅ Arquivo TXT criado', {
      txtPath: path.basename(txtPath),
      fileSize: `${(fullText.length / 1024).toFixed(2)}KB`,
      characters: fullText.length,
      words: fullText.split(' ').length
    });
    return txtPath;
  }

  async generateAllFormats(
    segments: TranscriptionSegment[],
    fullText: string,
    jobId: string
  ): Promise<{ srtPath: string; txtPath: string }> {
    const [srtPath, txtPath] = await Promise.all([
      this.generateSRT(segments, jobId),
      this.generateTXT(fullText, jobId)
    ]);

    return { srtPath, txtPath };
  }

  private formatSRTTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const milliseconds = Math.floor((seconds % 1) * 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${secs.toString().padStart(2, '0')},${milliseconds
      .toString()
      .padStart(3, '0')}`;
  }

  readSRTFile(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      throw new Error(`SRT file not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf8');
  }

  readTXTFile(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      throw new Error(`TXT file not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf8');
  }

  cleanup(jobId: string): void {
    try {
      const jobOutputDir = path.join(config.directories.output, jobId);
      if (fs.existsSync(jobOutputDir)) {
        fs.rmSync(jobOutputDir, { recursive: true, force: true });
        logger.info('🧹 Arquivos de saída limpos', {
          jobOutputDir: path.basename(jobOutputDir),
          phase: 'Output cleanup completed'
        });
      }
    } catch (error) {
      logger.error('⚠️ Falha na limpeza dos arquivos de saída', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
        phase: 'Output cleanup failed'
      });
    }
  }
}