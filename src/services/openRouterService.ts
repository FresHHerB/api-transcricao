import axios, { AxiosResponse } from 'axios';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { OpenRouterRequest, OpenRouterResponse, OpenRouterMessage } from '../types';

export class OpenRouterService {
  private readonly baseURL = 'https://openrouter.ai/api/v1';
  private readonly timeout: number;

  constructor() {
    this.timeout = config.imageGeneration.timeout;
  }

  async generatePrompt(
    texto: string,
    estilo: string,
    detalheEstilo: string,
    roteiro: string,
    agente: string,
    sceneIndex: number
  ): Promise<string> {
    const requestId = `openrouter_${Date.now()}_${sceneIndex}`;
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info('🎨 Generating prompt with OpenRouter', {
          requestId,
          sceneIndex,
          model: config.openrouter.model,
          textLength: texto.length,
          attempt,
          maxAttempts: maxRetries
        });

      const userContent = `###SCRIPT EXCERPT
${texto}

###VISUAL STYLE
${estilo}

###STYLE DETAILS
${detalheEstilo}

###FULL_SCRIPT
${roteiro}`;

      const messages: OpenRouterMessage[] = [
        {
          role: 'system',
          content: agente
        },
        {
          role: 'user',
          content: userContent
        }
      ];

      const requestData: OpenRouterRequest = {
        model: config.openrouter.model,
        messages,
        temperature: 0.7,
        max_tokens: 500
      };

      const response: AxiosResponse<OpenRouterResponse> = await axios.post(
        `${this.baseURL}/chat/completions`,
        requestData,
        {
          headers: {
            'Authorization': `Bearer ${config.openrouter.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://api-transcricao.example.com',
            'X-Title': 'API Transcricao - Image Generation'
          },
          timeout: this.timeout
        }
      );

      const generatedPrompt = response.data.choices[0]?.message?.content?.trim();

      if (!generatedPrompt) {
        throw new Error('Empty response from OpenRouter API');
      }

        logger.info('✅ Prompt generated successfully', {
          requestId,
          sceneIndex,
          promptLength: generatedPrompt.length,
          tokensUsed: response.data.usage?.total_tokens || 0,
          attemptsUsed: attempt
        });

        return generatedPrompt;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        const errorMessage = this.extractErrorMessage(error);

        logger.warn('⚠️ OpenRouter prompt generation attempt failed', {
          requestId,
          sceneIndex,
          error: errorMessage,
          model: config.openrouter.model,
          attempt,
          maxAttempts: maxRetries
        });

        if (attempt < maxRetries) {
          const retryDelay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          logger.info('⏳ Retrying prompt generation', {
            requestId,
            sceneIndex,
            retryDelayMs: retryDelay,
            nextAttempt: attempt + 1
          });
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    logger.error('❌ OpenRouter prompt generation failed after all retries', {
      requestId,
      sceneIndex,
      error: lastError?.message,
      model: config.openrouter.model,
      totalAttempts: maxRetries
    });

    throw new Error(`OpenRouter API failed after ${maxRetries} attempts: ${lastError?.message}`);
  }

  async generatePromptsForScenes(
    scenes: Array<{ index: number; texto: string }>,
    estilo: string,
    detalheEstilo: string,
    roteiro: string,
    agente: string
  ): Promise<Array<{ index: number; prompt: string }>> {
    logger.info('🎭 Starting batch prompt generation', {
      totalScenes: scenes.length,
      estilo,
      model: config.openrouter.model
    });

    const results = await Promise.allSettled(
      scenes.map(async (scene) => {
        const prompt = await this.generatePrompt(
          scene.texto,
          estilo,
          detalheEstilo,
          roteiro,
          agente,
          scene.index
        );
        return { index: scene.index, prompt };
      })
    );

    const successful = results
      .filter((result): result is PromiseFulfilledResult<{ index: number; prompt: string }> =>
        result.status === 'fulfilled'
      )
      .map(result => result.value);

    const failed: Array<{ sceneIndex: number; error: any }> = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failed.push({
          sceneIndex: scenes[index]?.index || index,
          error: result.reason
        });
      }
    });

    // Retry failed prompts
    if (failed.length > 0) {
      logger.warn('⚠️ Some prompt generations failed, retrying...', {
        successful: successful.length,
        failed: failed.length,
        failures: failed
      });

      const failedScenes = failed.map(f => scenes.find(s => s.index === f.sceneIndex)).filter(Boolean);

      if (failedScenes.length > 0) {
        logger.info('🔄 Retrying failed prompt generations', {
          retryCount: failedScenes.length
        });

        const retryResults = await Promise.allSettled(
          failedScenes.map(async (scene) => {
            if (!scene) return Promise.reject(new Error('Scene not found'));

            // Wait a bit before retry to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));

            const prompt = await this.generatePrompt(
              scene.texto,
              estilo,
              detalheEstilo,
              roteiro,
              agente,
              scene.index
            );
            return { index: scene.index, prompt };
          })
        );

        const retrySuccessful = retryResults
          .filter((result): result is PromiseFulfilledResult<{ index: number; prompt: string }> =>
            result.status === 'fulfilled'
          )
          .map(result => result.value);

        successful.push(...retrySuccessful);

        logger.info('🔄 Retry completed', {
          originalSuccessful: successful.length - retrySuccessful.length,
          retrySuccessful: retrySuccessful.length,
          totalSuccessful: successful.length,
          remainingFailed: failed.length - retrySuccessful.length
        });
      }
    }

    if (successful.length === 0) {
      throw new Error('All prompt generations failed after retries');
    }

    logger.info('🎉 Batch prompt generation completed', {
      successful: successful.length,
      failed: Math.max(0, scenes.length - successful.length),
      totalScenes: scenes.length,
      successRate: `${((successful.length / scenes.length) * 100).toFixed(1)}%`
    });

    return successful;
  }

  private extractErrorMessage(error: any): string {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        const status = error.response.status;
        const data = error.response.data;

        if (data?.error?.message) {
          return `HTTP ${status}: ${data.error.message}`;
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