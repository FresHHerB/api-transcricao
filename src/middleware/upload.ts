import multer from 'multer';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { config } from '../config/env';
import { logger } from '../utils/logger';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.directories.temp);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const originalName = path.parse(file.originalname);
    const filename = `${originalName.name}_${timestamp}${originalName.ext}`;
    cb(null, filename);
  }
});

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback): void => {
  const fileExtension = path.extname(file.originalname).toLowerCase().slice(1);
  const isValidFormat = config.audio.allowedFormats.includes(fileExtension);

  if (!isValidFormat) {
    logger.warn('File upload rejected: invalid format', {
      originalName: file.originalname,
      extension: fileExtension,
      allowedFormats: config.audio.allowedFormats
    });

    cb(new Error(`Invalid file format. Allowed formats: ${config.audio.allowedFormats.join(', ')}`));
    return;
  }

  logger.debug('File upload accepted', {
    originalName: file.originalname,
    extension: fileExtension,
    mimetype: file.mimetype
  });

  cb(null, true);
};

export const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.audio.maxFileSizeMB * 1024 * 1024
  }
}).single('audio');

// Função para validar metadados do áudio após upload
export const validateAudioFile = async (filePath: string): Promise<{ duration: number; suspicious: boolean; warning?: string }> => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        logger.error('❌ Erro ao analisar metadados do áudio', { error: err.message });
        reject(err);
        return;
      }

      const duration = metadata.format.duration || 0;
      const durationMinutes = duration / 60;
      const fileSize = metadata.format.size ? Number(metadata.format.size) : 0;
      const fileSizeMB = fileSize / 1024 / 1024;
      const bitRate = metadata.format.bit_rate ? Number(metadata.format.bit_rate) : 0;

      // VALIDAÇÃO CRÍTICA: Detectar corrupção de áudio e conteúdo suspeito
      const suspiciouslyLong = duration > 7200; // > 2 horas (possível duplicação)
      const possibleLoop = duration > 3600 && (duration % 1800 < 60 || duration % 1937 < 60); // Loops de 30min ou padrões específicos
      const possibleDuplication = duration > 1800 && fileSizeMB > 0 && (fileSizeMB / durationMinutes) < 0.5; // Taxa muito baixa MB/min indica duplicação

      // VALIDAÇÃO DE INTEGRIDADE: Detectar corrupção técnica
      const corruptionIndicators = {
        zeroBitrate: bitRate === 0 && duration > 0,
        invalidDuration: duration <= 0 || !isFinite(duration),
        suspiciousBitrate: bitRate > 0 && (bitRate < 8000 || bitRate > 320000), // Fora da faixa normal 8-320kbps
        emptyFile: fileSize === 0,
        impossibleRatio: fileSizeMB > 0 && duration > 0 && (fileSizeMB / durationMinutes) > 10 // > 10MB/min é suspeito
      };

      const hasCorruption = Object.values(corruptionIndicators).some(indicator => indicator);
      const hasSuspiciousContent = suspiciouslyLong || possibleLoop || possibleDuplication;
      const suspicious = hasCorruption || hasSuspiciousContent;

      // GERAÇÃO DE AVISOS DETALHADOS
      let warning = '';
      const warnings = [];

      if (suspiciouslyLong) warnings.push(`⚠️ Arquivo muito longo (${durationMinutes.toFixed(1)}min) - possível duplicação`);
      if (possibleLoop) warnings.push('🚨 Possível conteúdo em loop detectado');
      if (possibleDuplication) warnings.push(`📊 Taxa suspeita: ${(fileSizeMB / durationMinutes).toFixed(2)}MB/min - possível duplicação`);

      if (corruptionIndicators.zeroBitrate) warnings.push('❌ Bitrate zero detectado - arquivo possivelmente corrompido');
      if (corruptionIndicators.invalidDuration) warnings.push('❌ Duração inválida detectada');
      if (corruptionIndicators.suspiciousBitrate) warnings.push(`⚠️ Bitrate suspeito: ${Math.round(bitRate / 1000)}kbps`);
      if (corruptionIndicators.emptyFile) warnings.push('❌ Arquivo vazio (0 bytes)');
      if (corruptionIndicators.impossibleRatio) warnings.push(`🚨 Taxa impossível: ${(fileSizeMB / durationMinutes).toFixed(2)}MB/min - verificar integridade`);

      warning = warnings.join('; ');

      // ANÁLISE DE QUALIDADE E VALIDAÇÃO FINAL
      const qualityMetrics = {
        expectedBitrate: duration > 0 ? Math.round((fileSize * 8) / duration / 1000) : 0, // kbps calculado
        reportedBitrate: Math.round(bitRate / 1000),
        sizePerMinute: durationMinutes > 0 ? fileSizeMB / durationMinutes : 0,
        compressionRatio: bitRate > 0 && fileSizeMB > 0 ? (bitRate / 1000 * durationMinutes * 60 / 8) / fileSizeMB : 0
      };

      // DETECÇÃO DE PADRÕES ESPECÍFICOS DE CORRUPÇÃO
      const bitrateDiscrepancy = Math.abs(qualityMetrics.expectedBitrate - qualityMetrics.reportedBitrate);
      const suspiciousCompression = qualityMetrics.compressionRatio > 2 || qualityMetrics.compressionRatio < 0.5;

      if (bitrateDiscrepancy > 50 && qualityMetrics.reportedBitrate > 0) {
        warnings.push(`🔍 Discrepância de bitrate: calculado ${qualityMetrics.expectedBitrate}kbps vs reportado ${qualityMetrics.reportedBitrate}kbps`);
      }

      if (suspiciousCompression && qualityMetrics.compressionRatio > 0) {
        warnings.push(`📊 Compressão suspeita: ratio ${qualityMetrics.compressionRatio.toFixed(2)}`);
      }

      const logLevel = suspicious ? 'warn' : 'info';
      const logMessage = suspicious ? '🚨 ARQUIVO SUSPEITO DETECTADO - Validação de upload' : '🎵 Metadados do arquivo validados';

      logger[logLevel](logMessage, {
        duration: `${duration.toFixed(2)}s`,
        durationMinutes: `${durationMinutes.toFixed(1)}min`,
        fileSize: fileSizeMB > 0 ? `${fileSizeMB.toFixed(1)}MB` : 'unknown',
        bitRate: bitRate > 0 ? `${Math.round(bitRate / 1000)}kbps` : 'unknown',
        qualityMetrics: {
          sizePerMinute: `${qualityMetrics.sizePerMinute.toFixed(2)}MB/min`,
          expectedBitrate: `${qualityMetrics.expectedBitrate}kbps`,
          compressionHealth: suspiciousCompression ? '❌ SUSPEITO' : '✅ NORMAL'
        },
        corruptionIndicators: hasCorruption ? corruptionIndicators : undefined,
        suspicious,
        warningCount: warnings.length,
        ...(warning && { detailedWarning: warning }),
        recommendation: suspicious ? 'VERIFICAR ARQUIVO DE ORIGEM - possível corrupção ou duplicação detectada' : 'Arquivo aprovado para processamento'
      });

      // Atualizar warning final
      if (warnings.length > 0) {
        warning = warnings.join('; ');
      }

      resolve({ duration, suspicious, warning });
    });
  });
};

export const handleUploadError = (error: any, req: any, res: any, next: any): void => {
  if (error instanceof multer.MulterError) {
    logger.error('Multer upload error', {
      error: error.message,
      code: error.code,
      field: error.field
    });

    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: 'File too large',
        message: `Maximum file size is ${config.audio.maxFileSizeMB}MB`
      });
      return;
    }

    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({
        error: 'Invalid field name',
        message: 'File should be uploaded in the "audio" field'
      });
      return;
    }

    res.status(400).json({
      error: 'Upload error',
      message: error.message
    });
    return;
  }

  if (error) {
    logger.error('Upload error', { error: error.message });
    res.status(400).json({
      error: 'Upload error',
      message: error.message
    });
    return;
  }

  next();
};