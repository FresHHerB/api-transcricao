import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join, basename, extname } from 'path';
import axios from 'axios';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export class FFmpegService {
  private readonly tempDir: string;
  private readonly outputDir: string;

  constructor() {
    this.tempDir = config.directories.temp;
    this.outputDir = config.directories.output;
  }

  async addCaptionsToVideo(
    videoUrl: string,
    srtUrl: string,
    requestId: string
  ): Promise<{ outputPath: string; stats: any }> {
    const startTime = Date.now();

    try {
      logger.info('🎬 Starting video caption process', {
        requestId,
        videoUrl,
        srtUrl,
        phase: 'CAPTION_START'
      });

      // Step 1: Download video file
      logger.info('📥 Downloading video file', {
        requestId,
        videoUrl,
        phase: 'VIDEO_DOWNLOAD_START'
      });

      const videoPath = await this.downloadFile(
        videoUrl,
        'video',
        this.getFileExtension(videoUrl) || '.mp4',
        requestId
      );

      const videoStats = await fs.stat(videoPath);

      logger.info('✅ Video downloaded successfully', {
        requestId,
        videoPath,
        videoSizeMB: Math.round(videoStats.size / 1024 / 1024 * 100) / 100,
        phase: 'VIDEO_DOWNLOAD_SUCCESS'
      });

      // Step 2: Download SRT file
      logger.info('📥 Downloading SRT file', {
        requestId,
        srtUrl,
        phase: 'SRT_DOWNLOAD_START'
      });

      const srtPath = await this.downloadFile(srtUrl, 'subtitle', '.srt', requestId);

      logger.info('✅ SRT downloaded successfully', {
        requestId,
        srtPath,
        phase: 'SRT_DOWNLOAD_SUCCESS'
      });

      // Step 3: Validate SRT file
      await this.validateSrtFile(srtPath, requestId);

      // Step 4: Process video with FFmpeg
      logger.info('🎞️ Processing video with FFmpeg', {
        requestId,
        phase: 'FFMPEG_PROCESSING_START'
      });

      const outputPath = await this.processVideoWithFFmpeg(
        videoPath,
        srtPath,
        requestId
      );

      const outputStats = await fs.stat(outputPath);
      const processingTime = Date.now() - startTime;

      const stats = {
        inputVideoSize: videoStats.size,
        outputVideoSize: outputStats.size,
        compressionRatio: `${((outputStats.size / videoStats.size) * 100).toFixed(1)}%`,
        processingTimeMs: processingTime,
        processingTimeSeconds: Math.round(processingTime / 1000 * 100) / 100
      };

      logger.info('🎉 Video caption process completed successfully', {
        requestId,
        outputPath,
        stats,
        phase: 'CAPTION_SUCCESS'
      });

      // Cleanup temp files
      await this.cleanupTempFiles([videoPath, srtPath], requestId);

      return { outputPath, stats };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const processingTime = Date.now() - startTime;

      logger.error('💥 Video caption process failed', {
        requestId,
        error: errorMessage,
        processingTimeMs: processingTime,
        phase: 'CAPTION_FAILED'
      });

      throw error;
    }
  }

  private async downloadFile(
    url: string,
    type: string,
    extension: string,
    requestId: string
  ): Promise<string> {
    const filename = `${requestId}_${type}_${Date.now()}${extension}`;
    const filePath = join(this.tempDir, filename);

    try {
      // Encode URL properly for axios
      const encodedUrl = this.encodeUrlForAxios(url);

      logger.info(`📥 Attempting to download ${type} file`, {
        requestId,
        originalUrl: url,
        encodedUrl,
        type,
        phase: `${type.toUpperCase()}_DOWNLOAD_ATTEMPT`
      });

      const response = await axios({
        method: 'GET',
        url: encodedUrl,
        responseType: 'stream',
        timeout: 300000, // 5 minutes timeout
        headers: {
          'User-Agent': 'API-Transcricao/1.0'
        }
      });

      const writer = require('fs').createWriteStream(filePath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          logger.info(`✅ ${type} file downloaded`, {
            requestId,
            filePath,
            url
          });
          resolve(filePath);
        });

        writer.on('error', (error: Error) => {
          logger.error(`❌ Failed to download ${type} file`, {
            requestId,
            error: error.message,
            url
          });
          reject(error);
        });
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error(`❌ Failed to download ${type} file`, {
        requestId,
        error: errorMessage,
        url
      });

      throw new Error(`Failed to download ${type} file: ${errorMessage}`);
    }
  }

  private async validateSrtFile(srtPath: string, requestId: string): Promise<void> {
    try {
      const srtContent = await fs.readFile(srtPath, 'utf-8');

      // Basic SRT format validation
      const srtPattern = /^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*\n.+/m;

      if (!srtPattern.test(srtContent)) {
        throw new Error('Invalid SRT file format');
      }

      logger.info('✅ SRT file validation passed', {
        requestId,
        srtPath,
        contentLength: srtContent.length
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('❌ SRT file validation failed', {
        requestId,
        error: errorMessage,
        srtPath
      });

      throw new Error(`SRT validation failed: ${errorMessage}`);
    }
  }

  private async processVideoWithFFmpeg(
    videoPath: string,
    srtPath: string,
    requestId: string
  ): Promise<string> {
    const outputFilename = `${requestId}_captioned_${Date.now()}.mp4`;
    const outputPath = join(this.outputDir, outputFilename);

    // Normalize paths for FFmpeg (escape colons on Windows)
    const normalizedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    const ffmpegArgs = [
      '-y', // Overwrite output file
      '-i', videoPath, // Input video
      '-vf', `subtitles=filename='${normalizedSrtPath}'`, // Add subtitles
      '-c:v', 'libx264', // Video codec
      '-preset', 'veryfast', // Encoding preset
      '-crf', '20', // Quality setting
      '-c:a', 'copy', // Copy audio without re-encoding
      '-movflags', '+faststart', // Optimize for web streaming
      outputPath
    ];

    const ffmpegCommand = `ffmpeg ${ffmpegArgs.join(' ')}`;

    logger.info('🎬 Starting FFmpeg processing', {
      requestId,
      command: ffmpegCommand,
      inputVideo: videoPath,
      inputSrt: srtPath,
      outputPath
    });

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ffmpegArgs);

      let stderr = '';
      let stdout = '';

      ffmpeg.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();

        // Log progress information
        if (data.toString().includes('time=')) {
          const timeMatch = data.toString().match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
          if (timeMatch) {
            logger.debug('⏳ FFmpeg progress', {
              requestId,
              currentTime: timeMatch[1]
            });
          }
        }
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          logger.info('✅ FFmpeg processing completed successfully', {
            requestId,
            outputPath,
            exitCode: code
          });
          resolve(outputPath);
        } else {
          logger.error('❌ FFmpeg processing failed', {
            requestId,
            exitCode: code,
            stderr: stderr.slice(-1000), // Last 1000 chars of stderr
            command: ffmpegCommand
          });
          reject(new Error(`FFmpeg failed with exit code ${code}: ${stderr.slice(-500)}`));
        }
      });

      ffmpeg.on('error', (error) => {
        logger.error('❌ FFmpeg spawn error', {
          requestId,
          error: error.message,
          command: ffmpegCommand
        });
        reject(new Error(`FFmpeg spawn error: ${error.message}`));
      });
    });
  }

  private getFileExtension(url: string): string | null {
    try {
      const urlPath = new URL(url).pathname;
      return extname(urlPath);
    } catch {
      return null;
    }
  }

  private async cleanupTempFiles(filePaths: string[], requestId: string): Promise<void> {
    for (const filePath of filePaths) {
      try {
        await fs.unlink(filePath);
        logger.debug('🗑️ Temp file cleaned up', {
          requestId,
          filePath
        });
      } catch (error) {
        logger.warn('⚠️ Failed to cleanup temp file', {
          requestId,
          filePath,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  private encodeUrlForAxios(url: string): string {
    try {
      const urlObj = new URL(url);

      // Force HTTP for internal MinIO URLs (port 9000)
      if (urlObj.hostname === 'minio' && urlObj.port === '9000') {
        urlObj.protocol = 'http:';
      }

      // Split path into segments and encode each one separately
      const originalPathSegments = urlObj.pathname.split('/');
      const pathSegments = originalPathSegments.map(segment =>
        segment ? encodeURIComponent(segment) : segment
      );

      // Reconstruct the URL with encoded path
      urlObj.pathname = pathSegments.join('/');

      const finalUrl = urlObj.toString();

      logger.warn('🔍 URL ENCODING DEBUG', {
        originalUrl: url,
        finalUrl,
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port,
        originalPathSegments,
        encodedPathSegments: pathSegments
      });

      return finalUrl;
    } catch (error) {
      logger.warn('Failed to parse URL, using as-is', {
        url,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return url;
    }
  }

  async healthCheck(): Promise<{ ffmpegAvailable: boolean; version?: string }> {
    return new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', ['-version']);

      let output = '';

      ffmpeg.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          const versionMatch = output.match(/ffmpeg version ([^\s]+)/);
          const result: { ffmpegAvailable: boolean; version?: string } = {
            ffmpegAvailable: true
          };
          if (versionMatch && versionMatch[1]) {
            result.version = versionMatch[1];
          }
          resolve(result);
        } else {
          resolve({ ffmpegAvailable: false });
        }
      });

      ffmpeg.on('error', () => {
        resolve({ ffmpegAvailable: false });
      });
    });
  }
}