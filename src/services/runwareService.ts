import axios, { AxiosResponse } from 'axios';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { RunwareImageRequest, RunwareImageResponse } from '../types';

export class RunwareService {
  private readonly baseURL = 'https://api.runware.ai/v1';
  private readonly timeout: number;

  constructor() {
    this.timeout = config.imageGeneration.timeout;
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  async generateImage(
    prompt: string,
    model: string,
    width: number,
    height: number,
    sceneIndex: number,
    seed?: number
  ): Promise<string> {
    const requestId = `runware_${Date.now()}_${sceneIndex}`;

    try {
      logger.info('🖼️ Generating image with Runware', {
        requestId,
        sceneIndex,
        model,
        dimensions: `${width}x${height}`,
        promptLength: prompt.length
      });

      const taskUUID = this.generateUUID();

      const requestData: RunwareImageRequest = {
        taskType: 'imageInference',
        taskUUID,
        positivePrompt: prompt,
        model,
        width,
        height,
        outputType: 'URL',
        outputFormat: 'JPG',
        steps: 20,
        CFGScale: 7,
        ...(seed !== undefined && { seed })
      };

      const response: AxiosResponse<RunwareImageResponse> = await axios.post(
        `${this.baseURL}/image/inference`,
        [requestData],
        {
          headers: {
            'Authorization': `Bearer ${config.runware.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: this.timeout
        }
      );

      if (!response.data?.data || response.data.data.length === 0) {
        throw new Error('Empty response from Runware API');
      }

      const imageData = response.data.data[0];
      if (!imageData || !imageData.imageURL) {
        throw new Error('No image URL in Runware response');
      }

      logger.info('✅ Image generated successfully', {
        requestId,
        sceneIndex,
        taskUUID,
        imageUUID: imageData.imageUUID,
        responseTaskUUID: imageData.taskUUID,
        seed: imageData.seed,
        imageURL: imageData.imageURL
      });

      return imageData.imageURL;

    } catch (error) {
      const errorMessage = this.extractErrorMessage(error);

      logger.error('❌ Runware image generation failed', {
        requestId,
        sceneIndex,
        error: errorMessage,
        model,
        dimensions: `${width}x${height}`
      });

      throw new Error(`Runware API failed: ${errorMessage}`);
    }
  }

  async generateImagesForScenes(
    prompts: Array<{ index: number; prompt: string }>,
    model: string,
    width: number,
    height: number
  ): Promise<Array<{ index: number; imageURL: string }>> {
    logger.info('🎨 Starting batch image generation', {
      totalImages: prompts.length,
      model,
      dimensions: `${width}x${height}`,
      maxConcurrent: config.imageGeneration.maxConcurrentImages
    });

    const results = await this.processWithConcurrencyLimit(
      prompts,
      async (promptData) => {
        const imageURL = await this.generateImage(
          promptData.prompt,
          model,
          width,
          height,
          promptData.index
        );
        return { index: promptData.index, imageURL };
      },
      config.imageGeneration.maxConcurrentImages
    );

    const successful = results
      .filter((result): result is PromiseFulfilledResult<{ index: number; imageURL: string }> =>
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
      logger.warn('⚠️ Some image generations failed', {
        successful: successful.length,
        failed: failed.length,
        failures: failed
      });
    }

    if (successful.length === 0) {
      throw new Error('All image generations failed');
    }

    logger.info('🎉 Batch image generation completed', {
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

    for (let i = 0; i < items.length; i += limit) {
      const batch = items.slice(i, i + limit);
      const batchPromises = batch.map(item => processor(item));
      const batchResults = await Promise.allSettled(batchPromises);
      results.push(...batchResults);

      if (i + limit < items.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return results;
  }

  private extractErrorMessage(error: any): string {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const status = error.response.status;
        const data = error.response.data;

        if (data?.error?.message) {
          return `HTTP ${status}: ${data.error.message}`;
        }

        if (data?.message) {
          return `HTTP ${status}: ${data.message}`;
        }

        if (status === 401) {
          return 'Invalid or expired API key';
        }

        if (status === 429) {
          return 'Rate limit exceeded';
        }

        if (status === 402) {
          return 'Insufficient credits';
        }

        return `HTTP ${status}: ${error.response.statusText}`;
      }

      if (error.code === 'ECONNABORTED') {
        return 'Request timeout';
      }

      return error.message || 'Network error';
    }

    return error instanceof Error ? error.message : 'Unknown error';
  }
}