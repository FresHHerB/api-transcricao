import { promises as fs } from 'fs';
import { join } from 'path';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export class CleanupService {
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private readonly cleanupIntervalMs = 60 * 60 * 1000; // 1 hour

  constructor() {
    if (config.cleanup.autoCleanupTempFiles) {
      this.startCleanupScheduler();
    }
  }

  startCleanupScheduler(): void {
    logger.info('🧹 Starting automatic file cleanup scheduler', {
      intervalHours: this.cleanupIntervalMs / (60 * 60 * 1000),
      maxAgeHours: config.cleanup.tempFileMaxAgeHours,
      tempDir: config.directories.temp,
      outputDir: config.directories.output
    });

    this.cleanupIntervalId = setInterval(async () => {
      try {
        await this.cleanupOldFiles();
      } catch (error) {
        logger.error('❌ Cleanup scheduler error', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }, this.cleanupIntervalMs);

    // Run initial cleanup
    this.cleanupOldFiles().catch(error => {
      logger.error('❌ Initial cleanup error', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    });
  }

  stopCleanupScheduler(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
      logger.info('🛑 Stopped automatic file cleanup scheduler');
    }
  }

  async cleanupOldFiles(): Promise<void> {
    const startTime = Date.now();
    logger.info('🧹 Starting cleanup of old files', {
      maxAgeHours: config.cleanup.tempFileMaxAgeHours
    });

    const maxAgeMs = config.cleanup.tempFileMaxAgeHours * 60 * 60 * 1000;
    const cutoffTime = Date.now() - maxAgeMs;

    let totalFilesChecked = 0;
    let totalFilesDeleted = 0;
    let totalSizeDeleted = 0;

    // Clean temp files
    const tempStats = await this.cleanupDirectory(
      config.directories.temp,
      cutoffTime,
      'temp'
    );

    // Clean output files (videos and other outputs)
    const outputStats = await this.cleanupDirectory(
      config.directories.output,
      cutoffTime,
      'output'
    );

    totalFilesChecked = tempStats.filesChecked + outputStats.filesChecked;
    totalFilesDeleted = tempStats.filesDeleted + outputStats.filesDeleted;
    totalSizeDeleted = tempStats.sizeDeleted + outputStats.sizeDeleted;

    const processingTime = Date.now() - startTime;

    logger.info('✅ File cleanup completed', {
      processingTimeMs: processingTime,
      totalFilesChecked,
      totalFilesDeleted,
      totalSizeDeletedMB: Math.round(totalSizeDeleted / 1024 / 1024 * 100) / 100,
      tempDir: {
        filesChecked: tempStats.filesChecked,
        filesDeleted: tempStats.filesDeleted,
        sizeDeletedMB: Math.round(tempStats.sizeDeleted / 1024 / 1024 * 100) / 100
      },
      outputDir: {
        filesChecked: outputStats.filesChecked,
        filesDeleted: outputStats.filesDeleted,
        sizeDeletedMB: Math.round(outputStats.sizeDeleted / 1024 / 1024 * 100) / 100
      }
    });
  }

  private async cleanupDirectory(
    directory: string,
    cutoffTime: number,
    type: 'temp' | 'output'
  ): Promise<{ filesChecked: number; filesDeleted: number; sizeDeleted: number }> {
    let filesChecked = 0;
    let filesDeleted = 0;
    let sizeDeleted = 0;

    try {
      const files = await fs.readdir(directory);

      for (const file of files) {
        try {
          const filePath = join(directory, file);
          const stats = await fs.stat(filePath);

          if (stats.isFile()) {
            filesChecked++;

            if (stats.mtimeMs < cutoffTime) {
              await fs.unlink(filePath);
              filesDeleted++;
              sizeDeleted += stats.size;

              logger.debug(`🗑️ Deleted old ${type} file`, {
                filePath,
                ageHours: Math.round((Date.now() - stats.mtimeMs) / (60 * 60 * 1000) * 100) / 100,
                sizeMB: Math.round(stats.size / 1024 / 1024 * 100) / 100
              });
            }
          }
        } catch (error) {
          logger.warn(`⚠️ Failed to process ${type} file`, {
            file,
            directory,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      logger.debug(`📂 Processed ${type} directory`, {
        directory,
        filesChecked,
        filesDeleted,
        sizeDeletedMB: Math.round(sizeDeleted / 1024 / 1024 * 100) / 100
      });

    } catch (error) {
      logger.error(`❌ Failed to read ${type} directory`, {
        directory,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    return { filesChecked, filesDeleted, sizeDeleted };
  }

  async manualCleanup(): Promise<void> {
    logger.info('🧹 Manual cleanup triggered');
    await this.cleanupOldFiles();
  }

  getCleanupStatus(): {
    isRunning: boolean;
    maxAgeHours: number;
    intervalHours: number;
    directories: string[];
  } {
    return {
      isRunning: this.cleanupIntervalId !== null,
      maxAgeHours: config.cleanup.tempFileMaxAgeHours,
      intervalHours: this.cleanupIntervalMs / (60 * 60 * 1000),
      directories: [config.directories.temp, config.directories.output]
    };
  }
}

// Export singleton instance
export const cleanupService = new CleanupService();