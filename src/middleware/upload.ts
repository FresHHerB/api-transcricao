import multer from 'multer';
import path from 'path';
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