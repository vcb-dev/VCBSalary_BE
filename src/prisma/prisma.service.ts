import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

const MAX_CONNECT_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 1_000;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.$connect();
        return;
      } catch (error) {
        if (
          !isRetryableConnectionError(error) ||
          attempt === MAX_CONNECT_ATTEMPTS
        ) {
          throw error;
        }

        const delayMs = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
        this.logger.warn(
          `Chưa kết nối được PostgreSQL (${connectionErrorCode(error)}). ` +
            `Thử lại sau ${delayMs / 1_000}s ` +
            `(${attempt}/${MAX_CONNECT_ATTEMPTS}).`,
        );
        await delay(delayMs);
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

function isRetryableConnectionError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientInitializationError)) return false;
  return (
    error.retryable === true ||
    error.errorCode === 'P1001' ||
    error.errorCode === 'P1002' ||
    error.errorCode === 'P1017'
  );
}

function connectionErrorCode(error: unknown): string {
  return error instanceof Prisma.PrismaClientInitializationError
    ? (error.errorCode ?? 'network error')
    : 'unknown error';
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
