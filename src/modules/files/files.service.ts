import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  assertFileAllowed,
  sanitizeFileName,
} from '../../common/utils/file-validation.util';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseStorageClient } from './clients/supabase-storage.client';

export interface UploadableFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

interface FileAttachmentRecord {
  id: string;
  uploadedByUserId: string;
  originalFileName: string;
  mimeType: string;
  fileSizeBytes: bigint;
  storageKey: string;
  createdAt: Date;
}

/** Không trả `storageKey` ra API — chỉ dùng nội bộ để tạo signed URL (xem business rule M03). */
function toPublicShape(record: FileAttachmentRecord) {
  return {
    id: record.id,
    uploadedByUserId: record.uploadedByUserId,
    originalFileName: record.originalFileName,
    mimeType: record.mimeType,
    fileSizeBytes: Number(record.fileSizeBytes),
    createdAt: record.createdAt,
  };
}

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageClient,
  ) {}

  async upload(file: UploadableFile, uploadedByUserId: string) {
    assertFileAllowed(file);

    const sanitizedName = sanitizeFileName(file.originalname);
    const storageKey = `${randomUUID()}-${sanitizedName}`;
    await this.storage.upload(storageKey, file.buffer, file.mimetype);

    try {
      const created = await this.prisma.fileAttachment.create({
        data: {
          uploadedByUserId,
          originalFileName: sanitizedName,
          mimeType: file.mimetype,
          fileSizeBytes: BigInt(file.size),
          storageKey,
        },
      });
      return toPublicShape(created);
    } catch (error) {
      // Upload thành công nhưng ghi metadata thất bại: xóa bù để không sinh object mồ côi.
      await this.storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async getOne(userId: string, id: string) {
    const attachment = await this.getOrThrow(id);
    this.assertOwner(userId, attachment.uploadedByUserId);

    return this.toDownloadShape(attachment);
  }

  /**
   * Dùng nội bộ sau khi module nghiệp vụ đã kiểm tra quyền xem entity cha. Ví dụ TrafficService
   * kiểm tra scope employee/kỳ trước, rồi mới xin signed URL để Leader xem minh chứng của member.
   */
  async getForAuthorizedAccess(id: string) {
    const [attachment] = await this.getManyForAuthorizedAccess([id]);
    return attachment;
  }

  async getManyForAuthorizedAccess(ids: readonly string[]) {
    if (ids.length === 0) return [];

    const uniqueIds = [...new Set(ids)];
    const attachments = await this.prisma.fileAttachment.findMany({
      where: { id: { in: uniqueIds } },
    });
    if (attachments.length !== uniqueIds.length) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy file',
        HttpStatus.NOT_FOUND,
      );
    }

    const attachmentById = new Map(
      attachments.map((attachment) => [attachment.id, attachment]),
    );
    return Promise.all(
      ids.map((id) => this.toDownloadShape(attachmentById.get(id)!)),
    );
  }

  async remove(userId: string, id: string) {
    const attachment = await this.getOrThrow(id);
    this.assertOwner(userId, attachment.uploadedByUserId);

    const referenceCount = await this.prisma.trafficRecordAttachment.count({
      where: { fileAttachmentId: id },
    });
    if (referenceCount > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'File đang được dùng làm minh chứng; hãy gỡ khỏi bản ghi nháp trước khi xóa',
        HttpStatus.CONFLICT,
        { referenceCount },
      );
    }

    try {
      // DELETE chưa commit giữ khóa trên row cha trong lúc xóa storage. Nếu storage lỗi transaction
      // rollback; nếu một request đồng thời cố gắn file làm minh chứng, FK RESTRICT sẽ phân xử tại DB.
      await this.prisma.$transaction(async (tx) => {
        await tx.fileAttachment.delete({ where: { id } });
        await this.storage.remove(attachment.storageKey);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'File vừa được gắn làm minh chứng và không thể xóa',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  private async getOrThrow(id: string): Promise<FileAttachmentRecord> {
    const attachment = await this.prisma.fileAttachment.findUnique({
      where: { id },
    });
    if (!attachment) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy file',
        HttpStatus.NOT_FOUND,
      );
    }
    return attachment;
  }

  private assertOwner(userId: string, uploadedByUserId: string) {
    if (userId !== uploadedByUserId) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Bạn không có quyền truy cập file này',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async toDownloadShape(attachment: FileAttachmentRecord) {
    const downloadUrl = await this.storage.createSignedUrl(
      attachment.storageKey,
    );
    return { ...toPublicShape(attachment), downloadUrl };
  }
}
