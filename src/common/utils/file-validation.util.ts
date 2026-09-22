import { HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB — dùng cho minh chứng KPI/OKR/traffic

/**
 * MIME được phép -> đuôi file hợp lệ tương ứng. Đủ dùng cho "minh chứng" (ảnh chụp màn hình,
 * PDF, Excel/Word) theo mục 5.x của business spec — không phải allowlist tổng quát cho mọi loại
 * file trong tương lai, mở rộng khi có nhu cầu thật.
 */
const ALLOWED_MIME_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    '.docx',
  ],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    '.xlsx',
  ],
  'text/csv': ['.csv'],
};

export interface UploadableFile {
  originalname: string;
  mimetype: string;
  size: number;
}

/** Kiểm tra size + MIME + extension theo business rules của M03. Ném AppException nếu không hợp lệ. */
export function assertFileAllowed(file: UploadableFile): void {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `File vượt quá dung lượng cho phép (tối đa ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB)`,
      HttpStatus.BAD_REQUEST,
    );
  }

  const allowedExtensions = ALLOWED_MIME_EXTENSIONS[file.mimetype];
  if (!allowedExtensions) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Định dạng file "${file.mimetype}" không được hỗ trợ`,
      HttpStatus.BAD_REQUEST,
    );
  }

  const extension = extractExtension(file.originalname);
  if (!allowedExtensions.includes(extension)) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Đuôi file không khớp với định dạng khai báo (${file.mimetype})`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

export function extractExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx).toLowerCase() : '';
}

const UNSAFE_FILENAME_CHARS = /[/\\?%*:|"<>]/g;

/** Bỏ ký tự nguy hiểm cho tên object storage/hệ thống file, giữ nguyên đuôi file và khoảng trắng. */
export function sanitizeFileName(fileName: string): string {
  const extension = extractExtension(fileName);
  const baseName = extension ? fileName.slice(0, -extension.length) : fileName;
  const cleanedBase =
    baseName
      .normalize('NFC')
      .replace(UNSAFE_FILENAME_CHARS, '_')
      .trim()
      .slice(0, 150) || 'file';
  const cleanedExtension = extension.replace(/[^a-z0-9.]/g, '');
  return `${cleanedBase}${cleanedExtension}`;
}
