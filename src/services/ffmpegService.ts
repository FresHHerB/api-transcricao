import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join, basename, extname } from 'path';
import axios from 'axios';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import * as os from 'os';

export class FFmpegService {
  private readonly tempDir: string;
  private readonly outputDir: string;

  constructor() {
    this.tempDir = config.directories.temp;
    this.outputDir = config.directories.output;
  }

  /**
   * Monitor CPU usage during processing
   */
  private getCPUUsage(): { percentUsed: number; totalCores: number; loadAverage: number[]; memoryUsage: { used: number; total: number; percentUsed: number } } {
    const cpus = os.cpus();
    const totalCores = cpus.length;

    // Calculate CPU usage from each core
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / totalCores;
    const total = totalTick / totalCores;
    const percentUsed = 100 - ~~(100 * idle / total);

    // Load average (1, 5, 15 minutes)
    const loadAverage = os.loadavg();

    // Memory usage
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const memoryPercentUsed = (usedMemory / totalMemory) * 100;

    return {
      percentUsed,
      totalCores,
      loadAverage,
      memoryUsage: {
        used: Math.round(usedMemory / 1024 / 1024), // MB
        total: Math.round(totalMemory / 1024 / 1024), // MB
        percentUsed: Math.round(memoryPercentUsed * 100) / 100
      }
    };
  }

  /**
   * Start CPU monitoring interval
   */
  private startCPUMonitoring(requestId: string, phase: string): NodeJS.Timeout {
    const interval = setInterval(() => {
      const cpuStats = this.getCPUUsage();

      logger.info(`📊 CPU Monitor [${phase}]`, {
        requestId,
        phase,
        cpu: {
          usage: `${cpuStats.percentUsed}%`,
          cores: cpuStats.totalCores,
          loadAvg1m: cpuStats.loadAverage[0]?.toFixed(2) ?? 'N/A',
          loadAvg5m: cpuStats.loadAverage[1]?.toFixed(2) ?? 'N/A',
          loadAvg15m: cpuStats.loadAverage[2]?.toFixed(2) ?? 'N/A'
        },
        memory: {
          used: `${cpuStats.memoryUsage.used}MB`,
          total: `${cpuStats.memoryUsage.total}MB`,
          usage: `${cpuStats.memoryUsage.percentUsed}%`
        }
      });
    }, 2000); // Monitor every 2 seconds

    return interval;
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
      // Check if we need to force HTTP for internal MinIO
      let finalUrl = url;
      try {
        const urlObj = new URL(url);
        if (urlObj.hostname === 'minio' && urlObj.port === '9000') {
          urlObj.protocol = 'http:';
          finalUrl = urlObj.toString();
        }
      } catch (e) {
        // Invalid URL, use as-is
      }

      logger.info(`📥 Attempting to download ${type} file`, {
        requestId,
        type,
        phase: `${type.toUpperCase()}_DOWNLOAD_ATTEMPT`
      });

      const response = await axios({
        method: 'GET',
        url: finalUrl,
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

  private async getVideoMetadata(
    videoPath: string,
    requestId: string
  ): Promise<{ duration: number | null; totalFrames: number | null }> {
    return new Promise((resolve) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        videoPath
      ]);

      let output = '';

      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          try {
            const metadata = JSON.parse(output);
            const videoStream = metadata.streams?.find((s: any) => s.codec_type === 'video');

            const duration = parseFloat(metadata.format?.duration || '0') || null;
            const frameRate = videoStream ? parseFloat(videoStream.r_frame_rate?.split('/')[0] || '0') / parseFloat(videoStream.r_frame_rate?.split('/')[1] || '1') : null;
            const totalFrames = duration && frameRate ? Math.round(duration * frameRate) : null;

            logger.info('📊 Video metadata extracted', {
              requestId,
              duration: duration ? `${duration}s` : 'unknown',
              durationSeconds: duration,
              totalFrames,
              frameRate: frameRate ? `${frameRate.toFixed(2)}fps` : 'unknown',
              resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : 'unknown'
            });

            resolve({ duration, totalFrames });
          } catch (error) {
            logger.warn('⚠️ Failed to parse video metadata', {
              requestId,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
            resolve({ duration: null, totalFrames: null });
          }
        } else {
          logger.warn('⚠️ FFprobe failed, proceeding without metadata', {
            requestId,
            exitCode: code
          });
          resolve({ duration: null, totalFrames: null });
        }
      });
    });
  }

  private async processVideoWithFFmpeg(
    videoPath: string,
    srtPath: string,
    requestId: string
  ): Promise<string> {
    // Get video metadata first for progress calculation
    const metadata = await this.getVideoMetadata(videoPath, requestId);

    const outputFilename = `${requestId}_captioned_${Date.now()}.mp4`;
    const outputPath = join(this.outputDir, outputFilename);

    // Normalize paths for FFmpeg (escape colons on Windows)
    const normalizedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    const ffmpegArgs = [
      '-y', // Overwrite output file
      '-i', videoPath, // Input video
      '-vf', `subtitles=filename='${normalizedSrtPath}'`, // Add subtitles
      '-c:v', 'libx264', // Video codec
      '-preset', 'faster', // Optimized: 30-40% faster than veryfast, good quality
      '-crf', '23', // Optimized: Quality balance for faster encoding
      '-threads', '2', // Use both vCPU cores
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
      outputPath,
      videoMetadata: {
        duration: metadata.duration ? `${metadata.duration}s` : 'unknown',
        totalFrames: metadata.totalFrames || 'unknown'
      }
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

        // Enhanced progress logging with detailed metrics
        const output = data.toString();

        // Parse FFmpeg progress line
        if (output.includes('frame=') && output.includes('time=')) {
          const frameMatch = output.match(/frame=\s*(\d+)/);
          const fpsMatch = output.match(/fps=\s*([\d.]+)/);
          const qMatch = output.match(/q=\s*([\d.-]+)/);
          const sizeMatch = output.match(/size=\s*(\d+)kB/);
          const timeMatch = output.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
          const bitrateMatch = output.match(/bitrate=\s*([\d.]+)kbits\/s/);
          const speedMatch = output.match(/speed=\s*([\d.]+)x/);

          if (timeMatch) {
            // Convert current time to seconds
            const timeParts = timeMatch[1].split(':');
            const currentSeconds = parseInt(timeParts[0]) * 3600 + parseInt(timeParts[1]) * 60 + parseFloat(timeParts[2]);

            // Calculate progress percentage if we have video duration
            let progressPercentage: number | null = null;
            let estimatedTimeRemaining: string | null = null;

            if (metadata.duration && metadata.duration > 0) {
              progressPercentage = Math.min(Math.round((currentSeconds / metadata.duration) * 100), 100);

              // Estimate time remaining based on processing speed
              if (speedMatch && progressPercentage > 0) {
                const processingSpeed = parseFloat(speedMatch[1]);
                const remainingSeconds = metadata.duration - currentSeconds;
                const estimatedSecondsRemaining = remainingSeconds / processingSpeed;

                const minutes = Math.floor(estimatedSecondsRemaining / 60);
                const seconds = Math.round(estimatedSecondsRemaining % 60);
                estimatedTimeRemaining = `${minutes}m ${seconds}s`;
              }
            }

            const currentFrame = frameMatch ? parseInt(frameMatch[1]) : null;
            const totalFrames = metadata.totalFrames;
            const frameProgressPercentage = currentFrame && totalFrames ? Math.round((currentFrame / totalFrames) * 100) : null;

            const progressInfo = {
              requestId,
              frame: currentFrame,
              totalFrames,
              frameProgress: frameProgressPercentage ? `${frameProgressPercentage}%` : null,
              fps: fpsMatch ? parseFloat(fpsMatch[1]) : null,
              quality: qMatch ? parseFloat(qMatch[1]) : null,
              sizeKB: sizeMatch ? parseInt(sizeMatch[1]) : null,
              currentTime: timeMatch[1],
              currentSeconds: Math.round(currentSeconds * 100) / 100,
              totalDuration: metadata.duration ? `${Math.round(metadata.duration)}s` : null,
              progressPercentage,
              bitrate: bitrateMatch ? `${bitrateMatch[1]}kbits/s` : null,
              speed: speedMatch ? `${speedMatch[1]}x` : null,
              estimatedTimeRemaining,
              phase: 'FFMPEG_PROGRESS'
            };

            // Show progress info more frequently and always visible
            const shouldShowDetailedLog = !progressPercentage || progressPercentage % 5 === 0 ||
                                        (currentFrame && currentFrame % 100 === 0);

            if (shouldShowDetailedLog) {
              const progressDisplay = progressPercentage ? `${progressPercentage}%` :
                                    frameProgressPercentage ? `${frameProgressPercentage}% (frames)` :
                                    'processing...';
              logger.info(`🎬 FFmpeg Progress: ${progressDisplay}`, progressInfo);
            } else {
              logger.debug('🎬 FFmpeg Processing Progress', progressInfo);
            }
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


  async imageToVideoWithZoom(
    imageUrl: string,
    frameRate: number,
    duration: number,
    requestId: string
  ): Promise<{ outputPath: string; stats: any }> {
    const startTime = Date.now();

    try {
      // Log initial CPU state
      const initialCPU = this.getCPUUsage();
      logger.info('🎥 Starting image to video with zoom process', {
        requestId,
        imageUrl,
        frameRate,
        duration,
        phase: 'IMG2VID_START',
        systemInfo: {
          cpuCores: initialCPU.totalCores,
          cpuUsage: `${initialCPU.percentUsed}%`,
          memoryTotal: `${initialCPU.memoryUsage.total}MB`,
          memoryUsage: `${initialCPU.memoryUsage.percentUsed}%`
        }
      });

      // Step 1: Download image file
      logger.info('📥 Downloading image file', {
        requestId,
        imageUrl,
        phase: 'IMAGE_DOWNLOAD_START'
      });

      const imagePath = await this.downloadFile(
        imageUrl,
        'image',
        this.getFileExtension(imageUrl) || '.jpg',
        requestId
      );

      const imageStats = await fs.stat(imagePath);

      logger.info('✅ Image downloaded successfully', {
        requestId,
        imagePath,
        imageSizeMB: Math.round(imageStats.size / 1024 / 1024 * 100) / 100,
        phase: 'IMAGE_DOWNLOAD_SUCCESS'
      });

      // Step 2: Get image metadata to determine optimal processing resolution
      const imageMetadata = await this.getImageMetadata(imagePath, requestId);

      // Step 3: Process image to video with zoom using FFmpeg
      logger.info('🎞️ Processing image to video with FFmpeg', {
        requestId,
        frameRate,
        duration,
        phase: 'FFMPEG_IMG2VID_START'
      });

      const outputPath = await this.processImageToVideoWithFFmpeg(
        imagePath,
        frameRate,
        duration,
        imageMetadata,
        requestId
      );

      const outputStats = await fs.stat(outputPath);
      const processingTime = Date.now() - startTime;

      const stats = {
        inputImageSize: imageStats.size,
        outputVideoSize: outputStats.size,
        frameRate,
        videoDuration: duration,
        processingTimeMs: processingTime,
        processingTimeSeconds: Math.round(processingTime / 1000 * 100) / 100,
        imageResolution: imageMetadata ? `${imageMetadata.width}x${imageMetadata.height}` : 'unknown'
      };

      logger.info('🎉 Image to video process completed successfully', {
        requestId,
        outputPath,
        stats,
        phase: 'IMG2VID_SUCCESS'
      });

      // Cleanup temp files
      await this.cleanupTempFiles([imagePath], requestId);

      return { outputPath, stats };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const processingTime = Date.now() - startTime;

      logger.error('💥 Image to video process failed', {
        requestId,
        error: errorMessage,
        processingTimeMs: processingTime,
        phase: 'IMG2VID_FAILED'
      });

      throw error;
    }
  }

  private async getImageMetadata(
    imagePath: string,
    requestId: string
  ): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        imagePath
      ]);

      let output = '';

      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          try {
            const metadata = JSON.parse(output);
            const imageStream = metadata.streams?.find((s: any) => s.codec_type === 'video');

            if (imageStream && imageStream.width && imageStream.height) {
              const result = {
                width: imageStream.width,
                height: imageStream.height
              };

              logger.info('📊 Image metadata extracted', {
                requestId,
                resolution: `${result.width}x${result.height}`,
                aspectRatio: (result.width / result.height).toFixed(2)
              });

              resolve(result);
            } else {
              logger.warn('⚠️ Could not extract image dimensions', { requestId });
              resolve(null);
            }
          } catch (error) {
            logger.warn('⚠️ Failed to parse image metadata', {
              requestId,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
            resolve(null);
          }
        } else {
          logger.warn('⚠️ FFprobe failed for image, proceeding without metadata', {
            requestId,
            exitCode: code
          });
          resolve(null);
        }
      });
    });
  }

  private async processImageToVideoWithFFmpeg(
    imagePath: string,
    frameRate: number,
    duration: number,
    imageMetadata: { width: number; height: number } | null,
    requestId: string
  ): Promise<string> {
    const outputFilename = `${requestId}_img2vid_${Date.now()}.mp4`;
    const outputPath = join(this.outputDir, outputFilename);

    // Calculate total frames for progress tracking
    const totalFrames = Math.round(frameRate * duration);

    // Determine optimal upscale factor based on image resolution
    // Upscale 6x for Ken Burns effect (industry standard per research)
    // I/O bottleneck now solved with tmpfs, ultrafast preset, and optimized env
    const upscaleFactor = 6;
    let upscaleWidth = 6720;  // Default for standard images
    let upscaleHeight = 3840;

    if (imageMetadata) {
      upscaleWidth = imageMetadata.width * upscaleFactor;
      upscaleHeight = imageMetadata.height * upscaleFactor;
    }

    // Zoom calculation: start at 1.0, end at 1.324 (32.4% zoom)
    const zoomStart = 1.0;
    const zoomEnd = 1.324;
    const zoomDifference = zoomEnd - zoomStart; // 0.324

    // Build the complex FFmpeg filter for smooth zoom with upscaling
    const videoFilter = [
      // Step 1: Upscale image for smooth zoom (prevents pixel jitter)
      `scale=${upscaleWidth}:${upscaleHeight}:flags=lanczos`,

      // Step 2: Apply zoom with smooth movement
      `zoompan=z='min(${zoomStart}+${zoomDifference}*on/${totalFrames}, ${zoomEnd})':d=${totalFrames}:x='trunc(iw/2-(iw/zoom/2))':y='trunc(ih/2-(ih/zoom/2))':s=1920x1080:fps=${frameRate}`,

      // Step 3: Ensure proper pixel format for compatibility
      'format=yuv420p'
    ].join(',');

    const ffmpegArgs = [
      '-framerate', frameRate.toString(),
      '-loop', '1', // Loop the single image
      '-i', imagePath, // Input image
      '-vf', videoFilter, // Apply the complex video filter
      '-c:v', 'libx264', // Video codec
      '-preset', 'ultrafast', // Fastest preset (was 'faster') - prioritize speed
      '-crf', '23', // Slightly lower quality for speed (was 22)
      '-threads', '2', // Use both vCPU cores
      '-t', duration.toString(), // Video duration
      '-max_muxing_queue_size', '1024', // Prevent buffer issues
      '-y', // Overwrite output file
      outputPath
    ];

    const ffmpegCommand = `ffmpeg ${ffmpegArgs.join(' ')}`;

    // Set environment to use tmpfs for temp files (faster I/O)
    const ffmpegEnv = {
      ...process.env,
      TMPDIR: '/tmp',  // Use tmpfs mounted at /tmp
      TEMP: '/tmp',
      TMP: '/tmp'
    };

    logger.info('🎬 Starting FFmpeg image-to-video processing', {
      requestId,
      command: ffmpegCommand,
      inputImage: imagePath,
      outputPath,
      parameters: {
        frameRate,
        duration,
        totalFrames,
        zoomRange: `${zoomStart} → ${zoomEnd}`,
        upscaleFactor,
        upscaleResolution: `${upscaleWidth}x${upscaleHeight}`,
        finalResolution: '1920x1080'
      }
    });

    // Start CPU monitoring
    const cpuMonitor = this.startCPUMonitoring(requestId, 'IMG2VID_FFMPEG');

    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ffmpegArgs, { env: ffmpegEnv });

      let stderr = '';
      let stdout = '';

      ffmpeg.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();

        // Enhanced progress logging
        const output = data.toString();

        // Parse FFmpeg progress for image-to-video conversion
        if (output.includes('frame=') && output.includes('time=')) {
          const frameMatch = output.match(/frame=\s*(\d+)/);
          const fpsMatch = output.match(/fps=\s*([\d.]+)/);
          const qMatch = output.match(/q=\s*([\d.-]+)/);
          const sizeMatch = output.match(/size=\s*(\d+)kB/);
          const timeMatch = output.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
          const bitrateMatch = output.match(/bitrate=\s*([\d.]+)kbits\/s/);
          const speedMatch = output.match(/speed=\s*([\d.]+)x/);

          if (timeMatch && frameMatch) {
            const currentFrame = parseInt(frameMatch[1]);
            const frameProgressPercentage = Math.min(Math.round((currentFrame / totalFrames) * 100), 100);

            // Convert current time to seconds
            const timeParts = timeMatch[1].split(':');
            const currentSeconds = parseInt(timeParts[0]) * 3600 + parseInt(timeParts[1]) * 60 + parseFloat(timeParts[2]);

            const timeProgressPercentage = Math.min(Math.round((currentSeconds / duration) * 100), 100);

            // Use the more accurate progress metric
            const progressPercentage = Math.max(frameProgressPercentage, timeProgressPercentage);

            // Estimate time remaining
            let estimatedTimeRemaining: string | null = null;
            if (speedMatch && progressPercentage > 0 && progressPercentage < 100) {
              const processingSpeed = parseFloat(speedMatch[1]);
              const remainingSeconds = duration - currentSeconds;
              const estimatedSecondsRemaining = remainingSeconds / processingSpeed;

              const minutes = Math.floor(estimatedSecondsRemaining / 60);
              const seconds = Math.round(estimatedSecondsRemaining % 60);
              estimatedTimeRemaining = `${minutes}m ${seconds}s`;
            }

            const progressInfo = {
              requestId,
              frame: currentFrame,
              totalFrames,
              frameProgress: `${frameProgressPercentage}%`,
              timeProgress: `${timeProgressPercentage}%`,
              overallProgress: `${progressPercentage}%`,
              fps: fpsMatch ? parseFloat(fpsMatch[1]) : null,
              quality: qMatch ? parseFloat(qMatch[1]) : null,
              sizeKB: sizeMatch ? parseInt(sizeMatch[1]) : null,
              currentTime: timeMatch[1],
              currentSeconds: Math.round(currentSeconds * 100) / 100,
              totalDuration: `${duration}s`,
              bitrate: bitrateMatch ? `${bitrateMatch[1]}kbits/s` : null,
              speed: speedMatch ? `${speedMatch[1]}x` : null,
              estimatedTimeRemaining,
              phase: 'IMG2VID_PROGRESS'
            };

            // Show progress info every 5% or every 50 frames
            const shouldShowDetailedLog = progressPercentage % 5 === 0 || currentFrame % 50 === 0;

            if (shouldShowDetailedLog) {
              logger.info(`🎥 Img2Vid Progress: ${progressPercentage}%`, progressInfo);
            } else {
              logger.debug('🎥 Img2Vid Processing Progress', progressInfo);
            }
          }
        }
      });

      ffmpeg.on('close', (code) => {
        // Stop CPU monitoring
        clearInterval(cpuMonitor);

        // Log final CPU state
        const finalCPU = this.getCPUUsage();
        logger.info('📊 Final CPU State [IMG2VID_FFMPEG]', {
          requestId,
          cpu: {
            usage: `${finalCPU.percentUsed}%`,
            cores: finalCPU.totalCores,
            loadAvg1m: finalCPU.loadAverage[0]?.toFixed(2) ?? 'N/A'
          },
          memory: {
            used: `${finalCPU.memoryUsage.used}MB`,
            total: `${finalCPU.memoryUsage.total}MB`,
            usage: `${finalCPU.memoryUsage.percentUsed}%`
          }
        });

        if (code === 0) {
          logger.info('✅ FFmpeg image-to-video processing completed successfully', {
            requestId,
            outputPath,
            exitCode: code,
            finalStats: {
              totalFrames,
              duration: `${duration}s`,
              frameRate: `${frameRate}fps`,
              zoomEffect: `${zoomStart} → ${zoomEnd}`
            }
          });
          resolve(outputPath);
        } else {
          logger.error('❌ FFmpeg image-to-video processing failed', {
            requestId,
            exitCode: code,
            stderr: stderr.slice(-1000), // Last 1000 chars of stderr
            command: ffmpegCommand
          });
          reject(new Error(`FFmpeg failed with exit code ${code}: ${stderr.slice(-500)}`));
        }
      });

      ffmpeg.on('error', (error) => {
        // Stop CPU monitoring on error
        clearInterval(cpuMonitor);

        logger.error('❌ FFmpeg spawn error for image-to-video', {
          requestId,
          error: error.message,
          command: ffmpegCommand
        });
        reject(new Error(`FFmpeg spawn error: ${error.message}`));
      });
    });
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