import { Runware } from '@runware/sdk-js';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export class RunwareWebSocketService {
  private runware: any;
  private isConnected: boolean = false;
  private connectionPromise: Promise<void> | null = null;
  private connectionPool: any[] = [];
  private maxConnections: number = 3;
  private connectionAttempts: number = 0;
  private maxConnectionAttempts: number = 5;
  private connectionCooldown: number = 2000;

  constructor() {
    this.runware = new Runware({
      apiKey: config.runware.apiKey,
      shouldReconnect: true,
      globalMaxRetries: 5,
      timeoutDuration: config.imageGeneration.timeout
    });
  }

  private async ensureConnection(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.connect();
    return this.connectionPromise;
  }

  private async connect(): Promise<void> {
    while (this.connectionAttempts < this.maxConnectionAttempts) {
      try {
        this.connectionAttempts++;
        logger.info('🔌 Connecting to Runware WebSocket API', {
          attempt: this.connectionAttempts,
          maxAttempts: this.maxConnectionAttempts
        });

        await this.runware.connect();
        this.isConnected = true;
        this.connectionPromise = null;
        this.connectionAttempts = 0; // Reset on successful connection

        logger.info('✅ Connected to Runware WebSocket API', {
          attemptsTaken: this.connectionAttempts
        });

        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        logger.warn('⚠️ WebSocket connection attempt failed', {
          attempt: this.connectionAttempts,
          maxAttempts: this.maxConnectionAttempts,
          error: errorMessage
        });

        if (this.connectionAttempts < this.maxConnectionAttempts) {
          logger.info('⏳ Waiting before retry', {
            cooldownMs: this.connectionCooldown,
            nextAttempt: this.connectionAttempts + 1
          });
          await new Promise(resolve => setTimeout(resolve, this.connectionCooldown));
          this.connectionCooldown *= 1.5; // Exponential backoff
        } else {
          this.isConnected = false;
          this.connectionPromise = null;
          this.connectionAttempts = 0;
          logger.error('❌ Failed to connect to Runware WebSocket API after all attempts', {
            totalAttempts: this.maxConnectionAttempts,
            finalError: errorMessage
          });
          throw new Error(`WebSocket connection failed after ${this.maxConnectionAttempts} attempts: ${errorMessage}`);
        }
      }
    }
  }

  async generateImage(
    prompt: string,
    model: string,
    width: number,
    height: number,
    sceneIndex: number
  ): Promise<{ imageURL: string; prompt: string }> {
    const requestId = `runware_ws_${Date.now()}_${sceneIndex}`;
    const maxRetries = 3;
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      try {
        await this.ensureConnection();

        logger.info('🖼️ Generating image with Runware WebSocket', {
          requestId,
          sceneIndex,
          model,
          dimensions: `${width}x${height}`,
          promptLength: prompt.length,
          attempt: retryCount + 1,
          maxAttempts: maxRetries + 1
        });

        const requestOptions = {
          positivePrompt: prompt,
          model,
          width,
          height,
          numberResults: 1
        };

        const images = await this.runware.requestImages(requestOptions);

        if (!images || images.length === 0) {
          throw new Error('No images returned from Runware WebSocket API');
        }

        const image = images[0];
        if (!image || !image.imageURL) {
          throw new Error('No image URL in Runware WebSocket response');
        }

        logger.info('✅ Image generated successfully via WebSocket', {
          requestId,
          sceneIndex,
          imageUUID: image.imageUUID,
          seed: image.seed,
          imageURL: image.imageURL,
          retriesUsed: retryCount
        });

        return { imageURL: image.imageURL, prompt };

      } catch (error) {
        const errorMessage = this.extractErrorMessage(error);
        retryCount++;

        logger.warn('⚠️ Runware WebSocket image generation attempt failed', {
          requestId,
          sceneIndex,
          error: errorMessage,
          model,
          dimensions: `${width}x${height}`,
          attempt: retryCount,
          maxAttempts: maxRetries + 1
        });

        // Try to reconnect on connection errors
        if (errorMessage.includes('connection') || errorMessage.includes('WebSocket') || errorMessage.includes('timeout')) {
          this.isConnected = false;
          this.connectionPromise = null;
          logger.info('🔄 Marking connection as disconnected due to error');
        }

        if (retryCount <= maxRetries) {
          const retryDelay = Math.min(1000 * Math.pow(2, retryCount - 1), 5000); // Exponential backoff with max 5s
          logger.info('⏳ Retrying image generation', {
            requestId,
            sceneIndex,
            retryDelayMs: retryDelay,
            nextAttempt: retryCount + 1
          });
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          logger.error('❌ Runware WebSocket image generation failed after all retries', {
            requestId,
            sceneIndex,
            error: errorMessage,
            totalAttempts: maxRetries + 1,
            model,
            dimensions: `${width}x${height}`
          });
          throw new Error(`Runware WebSocket API failed after ${maxRetries + 1} attempts: ${errorMessage}`);
        }
      }
    }

    throw new Error('Unexpected error in generateImage retry loop');
  }

  async generateImagesForScenes(
    prompts: Array<{ index: number; prompt: string }>,
    model: string,
    width: number,
    height: number
  ): Promise<Array<{ index: number; imageURL: string; prompt: string }>> {
    await this.ensureConnection();

    logger.info('🎨 Starting batch image generation via WebSocket', {
      totalImages: prompts.length,
      model,
      dimensions: `${width}x${height}`,
      maxConcurrent: config.imageGeneration.maxConcurrentImages
    });

    // Process images in parallel batches for better performance
    const results = await this.processWithConcurrencyLimit(
      prompts,
      async (promptData) => {
        const result = await this.generateImage(
          promptData.prompt,
          model,
          width,
          height,
          promptData.index
        );
        return { index: promptData.index, imageURL: result.imageURL, prompt: result.prompt };
      },
      config.imageGeneration.maxConcurrentImages
    );

    const successful = results
      .filter((result): result is PromiseFulfilledResult<{ index: number; imageURL: string; prompt: string }> =>
        result.status === 'fulfilled'
      )
      .map(result => result.value);

    const failed: Array<{ sceneIndex: number; error: any }> = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failed.push({
          sceneIndex: prompts[index]?.index || index,
          error: result.reason
        });
      }
    });

    if (failed.length > 0) {
      logger.warn('⚠️ Some WebSocket image generations failed', {
        successful: successful.length,
        failed: failed.length,
        failures: failed
      });
    }

    if (successful.length === 0) {
      throw new Error('All WebSocket image generations failed');
    }

    logger.info('🎉 Batch WebSocket image generation completed', {
      successful: successful.length,
      failed: failed.length,
      totalImages: prompts.length
    });

    return successful;
  }

  private async processWithConcurrencyLimit<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    limit: number
  ): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = [];

    // Use configured batch size from environment settings
    const optimalBatchSize = config.imageGeneration.batchSize; // Use dedicated BATCH_SIZE_IMAGES setting

    logger.info('🚀 Starting optimized concurrent processing', {
      totalItems: items.length,
      batchSize: optimalBatchSize,
      estimatedBatches: Math.ceil(items.length / optimalBatchSize)
    });

    for (let i = 0; i < items.length; i += optimalBatchSize) {
      const batch = items.slice(i, i + optimalBatchSize);
      const batchNumber = Math.floor(i / optimalBatchSize) + 1;
      const totalBatches = Math.ceil(items.length / optimalBatchSize);

      logger.info('⚡ Processing batch', {
        batchNumber,
        totalBatches,
        batchSize: batch.length,
        itemsRemaining: items.length - i - batch.length
      });

      const batchStartTime = Date.now();
      const batchPromises = batch.map(item => processor(item));
      const batchResults = await Promise.allSettled(batchPromises);
      const batchDuration = Date.now() - batchStartTime;

      const batchSuccessCount = batchResults.filter(r => r.status === 'fulfilled').length;
      const batchFailureCount = batchResults.filter(r => r.status === 'rejected').length;

      logger.info('✅ Batch completed', {
        batchNumber,
        durationMs: batchDuration,
        successful: batchSuccessCount,
        failed: batchFailureCount,
        successRate: `${((batchSuccessCount / batch.length) * 100).toFixed(1)}%`
      });

      results.push(...batchResults);

      // Dynamic delay based on performance and remaining batches
      if (i + optimalBatchSize < items.length) {
        const adaptiveDelay = batchFailureCount > 0 ? 1000 : 200; // Longer delay if failures occurred
        logger.info('⏳ Inter-batch delay', {
          delayMs: adaptiveDelay,
          reason: batchFailureCount > 0 ? 'failures_detected' : 'normal_throttling'
        });
        await new Promise(resolve => setTimeout(resolve, adaptiveDelay));
      }
    }

    const totalSuccessful = results.filter(r => r.status === 'fulfilled').length;
    const totalFailed = results.filter(r => r.status === 'rejected').length;

    logger.info('🎯 Concurrent processing completed', {
      totalItems: items.length,
      successful: totalSuccessful,
      failed: totalFailed,
      overallSuccessRate: `${((totalSuccessful / items.length) * 100).toFixed(1)}%`
    });

    return results;
  }

  private extractErrorMessage(error: any): string {
    if (error && typeof error === 'object') {
      if (error.message) {
        return error.message;
      }
      if (error.error) {
        return error.error;
      }
    }
    return error instanceof Error ? error.message : 'Unknown error';
  }

  async disconnect(): Promise<void> {
    if (this.isConnected) {
      try {
        await this.runware.disconnect();
        this.isConnected = false;
        this.connectionPromise = null;
        logger.info('🔌 Disconnected from Runware WebSocket API');
      } catch (error) {
        logger.warn('⚠️ Error disconnecting from Runware WebSocket API', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  // Connection health check
  async healthCheck(): Promise<{ status: string; connected: boolean; attempts: number }> {
    return {
      status: this.isConnected ? 'healthy' : 'disconnected',
      connected: this.isConnected,
      attempts: this.connectionAttempts
    };
  }

  // Reset connection state (useful for recovery)
  async resetConnection(): Promise<void> {
    logger.info('🔄 Resetting WebSocket connection state');
    this.isConnected = false;
    this.connectionPromise = null;
    this.connectionAttempts = 0;
    this.connectionCooldown = 2000;

    try {
      await this.disconnect();
    } catch (error) {
      logger.warn('⚠️ Error during connection reset', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Graceful shutdown method
  async shutdown(): Promise<void> {
    logger.info('🛑 Shutting down Runware WebSocket Service');
    await this.disconnect();
    logger.info('✅ Runware WebSocket Service shutdown complete');
  }
}