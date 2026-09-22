import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';

const DEFAULT_BUCKET = 'attachments';
const SIGNED_URL_EXPIRES_IN_SECONDS = 600; // 10 phút — đủ để client tải file ngay sau khi mở

/**
 * Wrapper quanh @supabase/supabase-js Storage — bucket private, chỉ tạo signed URL ngắn hạn
 * khi thật sự cần tải file (xem business rule "không expose private storage key trực tiếp").
 * Client Supabase được tạo lazy trong mỗi lời gọi (không ở constructor) để tránh crash app
 * bootstrap khi SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY chưa được cấu hình.
 */
@Injectable()
export class SupabaseStorageClient {
  private client?: ReturnType<typeof createClient>;
  private bucketName?: string;

  constructor(private readonly config: ConfigService) {}

  async upload(
    storageKey: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<void> {
    const { error } = await this.getBucket().upload(storageKey, buffer, {
      contentType: mimeType,
      upsert: false,
    });
    if (error) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `Lỗi upload lên Supabase Storage: ${error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async remove(storageKey: string): Promise<void> {
    const { error } = await this.getBucket().remove([storageKey]);
    if (error) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `Lỗi xóa file trên Supabase Storage: ${error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  async createSignedUrl(storageKey: string): Promise<string> {
    const { data, error } = await this.getBucket().createSignedUrl(
      storageKey,
      SIGNED_URL_EXPIRES_IN_SECONDS,
    );
    if (error || !data) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `Lỗi tạo signed URL: ${error?.message ?? 'unknown error'}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    return data.signedUrl;
  }

  private getBucket() {
    if (this.client && this.bucketName) {
      return this.client.storage.from(this.bucketName);
    }
    const url = this.config.get<string>('SUPABASE_URL', '');
    const serviceRoleKey = this.config.get<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
      '',
    );
    if (!url || !serviceRoleKey) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    this.bucketName = this.config.get<string>(
      'SUPABASE_STORAGE_BUCKET',
      DEFAULT_BUCKET,
    );
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
    return this.client.storage.from(this.bucketName);
  }
}
