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

      // Detectar arquivos suspeitos
      const suspiciouslyLong = duration > 7200; // > 2 horas
      const possibleLoop = duration > 3600 && (duration % 1800 < 60 || duration % 1937 < 60);
      const suspicious = suspiciouslyLong || possibleLoop;

      let warning = '';
      if (suspiciouslyLong) warning = '⚠️ Arquivo muito longo - possível duplicação';
      if (possibleLoop) warning = '🚨 Possível conteúdo em loop detectado';

      logger.info('🎵 Metadados do arquivo validados', {
        duration: `${duration.toFixed(2)}s`,
        durationMinutes: `${durationMinutes.toFixed(1)}min`,
        fileSize: metadata.format.size ? `${(Number(metadata.format.size) / 1024 / 1024).toFixed(1)}MB` : 'unknown',
        bitRate: metadata.format.bit_rate ? `${Math.round(Number(metadata.format.bit_rate) / 1000)}kbps` : 'unknown',
        suspicious,
        ...(warning && { warning })
      });

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