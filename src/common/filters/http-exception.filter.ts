import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { ErrorCode } from '../errors/error-codes';

const STATUS_TO_CODE: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
};

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = request.requestId;

    const status = this.resolveStatus(exception);

    const body = this.resolveBody(exception, status);

    const logLine = `[${requestId ?? '-'}] ${request.method} ${request.originalUrl} -> ${status} ${body.code}`;
    const isServerError = status >= 500;
    if (isServerError) {
      this.logger.error(
        logLine,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(logLine);
    }

    response.status(status).json({ ...body, requestId });
  }

  private resolveStatus(exception: unknown) {
    if (exception instanceof HttpException) return exception.getStatus();
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2000':
          return HttpStatus.BAD_REQUEST;
        case 'P2002':
        case 'P2003':
        case 'P2034':
          return HttpStatus.CONFLICT;
        case 'P2025':
          return HttpStatus.NOT_FOUND;
      }
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private resolveBody(exception: unknown, status: number): ErrorBody {
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;

        if (typeof record.code === 'string') {
          return {
            code: record.code,
            message: (record.message as string) ?? exception.message,
            details: record.details,
          };
        }

        if (Array.isArray(record.message)) {
          return {
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Dữ liệu gửi lên không hợp lệ',
            details: { errors: record.message },
          };
        }

        if (typeof record.message === 'string') {
          return {
            code: STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL_ERROR,
            message: record.message,
          };
        }
      }

      return {
        code: STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL_ERROR,
        message: exception.message,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2000':
          return {
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Giá trị dữ liệu vượt quá giới hạn cho phép',
          };
        case 'P2002':
          return {
            code: ErrorCode.CONFLICT,
            message: 'Dữ liệu đã tồn tại hoặc bị trùng lặp',
          };
        case 'P2003':
          return {
            code: ErrorCode.CONFLICT,
            message: 'Không thể thay đổi dữ liệu đang được tham chiếu',
          };
        case 'P2025':
          return {
            code: ErrorCode.NOT_FOUND,
            message: 'Không tìm thấy dữ liệu cần thao tác',
          };
        case 'P2034':
          return {
            code: ErrorCode.CONFLICT,
            message: 'Dữ liệu vừa được thay đổi bởi một yêu cầu khác',
          };
      }
    }

    return {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Đã xảy ra lỗi hệ thống',
    };
  }
}
