import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

const MAX_CONNECT_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 1_000;
// Interactive transaction chạy tuần tự trên một connection (Promise.all bên trong không song song).
// DB ở Singapore nên chỉ ~8 round-trip lúc mạng chậm đã vượt mặc định 5s của Prisma (P2028), làm
// rollback cả thao tác ghi lẫn audit. Đặt mặc định chung để mọi `$transaction(async …)` đều có
// biên độ; nơi nào cần khác vẫn truyền options riêng để ghi đè.
const TRANSACTION_MAX_WAIT_MS = 10_000;
const TRANSACTION_TIMEOUT_MS = 30_000;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      transactionOptions: {
        maxWait: TRANSACTION_MAX_WAIT_MS,
        timeout: TRANSACTION_TIMEOUT_MS,
      },
    });
  }

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
