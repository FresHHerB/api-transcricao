import localtunnel from 'localtunnel';
import { logger } from '../utils/logger';
import { config } from '../config/env';

export class TunnelService {
  private tunnel: any = null;
  private isActive: boolean = false;

  async startTunnel(): Promise<string | null> {
    try {
      // Only start tunnel in development mode
      if (config.nodeEnv !== 'development') {
        logger.info('🌐 Tunnel not started - only available in development mode');
        return null;
      }

      logger.info('🚇 Starting localtunnel...');

      this.tunnel = await localtunnel({
        port: config.port,
        subdomain: process.env.TUNNEL_SUBDOMAIN || undefined
      });

      this.isActive = true;
      const publicUrl = this.tunnel.url;

      logger.info('🌍 ========================================');
      logger.info('🌍 PUBLIC URL AVAILABLE!');
      logger.info(`🌍 URL: ${publicUrl}`);
      logger.info(`🌍 Local: http://localhost:${config.port}`);
      logger.info('🌍 ========================================');
      logger.info('');
      logger.info('📡 PUBLIC ENDPOINTS:');
      logger.info(`   - Health: ${publicUrl}/health`);
      logger.info(`   - Video Health: ${publicUrl}/video/health`);
      logger.info(`   - Transcribe: ${publicUrl}/transcribe`);
      logger.info(`   - Gerar Prompts: ${publicUrl}/gerarPrompts`);
      logger.info(`   - Gerar Imagens: ${publicUrl}/gerarImagens`);
      logger.info(`   - Video Caption: ${publicUrl}/video/caption`);
      logger.info(`   - Video Img2Vid: ${publicUrl}/video/img2vid`);
      logger.info(`   - API Docs: ${publicUrl}`);
      logger.info('🌍 ========================================');
      logger.info('');

      // Handle tunnel errors
      this.tunnel.on('close', () => {
        logger.warn('🚇 Localtunnel closed');
        this.isActive = false;
      });

      this.tunnel.on('error', (err: Error) => {
        logger.error('🚇 Localtunnel error:', {
          error: err.message
        });
        this.isActive = false;
      });

      return publicUrl;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('❌ Failed to start localtunnel:', {
        error: errorMessage
      });
      this.isActive = false;
      return null;
    }
  }

  async stopTunnel(): Promise<void> {
    if (this.tunnel) {
      try {
        logger.info('🚇 Stopping localtunnel...');
        this.tunnel.close();
        this.isActive = false;
        logger.info('✅ Localtunnel stopped');
      } catch (error) {
        logger.error('❌ Error stopping localtunnel:', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  getTunnelStatus(): { isActive: boolean; url: string | null } {
    return {
      isActive: this.isActive,
      url: this.tunnel ? this.tunnel.url : null
    };
  }
}

export const tunnelService = new TunnelService();
