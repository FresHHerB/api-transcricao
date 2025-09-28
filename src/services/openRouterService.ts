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

    try {
      logger.info('🎨 Generating prompt with OpenRouter', {
        requestId,
        sceneIndex,
        model: config.openrouter.model,
        textLength: texto.length
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
        tokensUsed: response.data.usage?.total_tokens || 0
      });

      return generatedPrompt;

    } catch (error) {
      const errorMessage = this.extractErrorMessage(error);

      logger.error('❌ OpenRouter prompt generation failed', {
        requestId,
        sceneIndex,
        error: errorMessage,
        model: config.openrouter.model
      });

      throw new Error(`OpenRouter API failed: ${errorMessage}`);
    }
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

    if (failed.length > 0) {
      logger.warn('⚠️ Some prompt generations failed', {
        successful: successful.length,
        failed: failed.length,
        failures: failed
      });
    }

    if (successful.length === 0) {
      throw new Error('All prompt generations failed');
    }

    logger.info('🎉 Batch prompt generation completed', {
      successful: successful.length,
      failed: failed.length,
      totalScenes: scenes.length
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