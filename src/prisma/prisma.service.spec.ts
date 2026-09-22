import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries a transient P1001 connection failure', async () => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new PrismaService();
    const connect = jest
      .spyOn(service, '$connect')
      .mockRejectedValueOnce(
        new Prisma.PrismaClientInitializationError(
          'Cannot reach database',
          '6.19.3',
          'P1001',
        ),
      )
      .mockResolvedValueOnce();

    const initializing = service.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    await initializing;

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent initialization error', async () => {
    const service = new PrismaService();
    const error = new Prisma.PrismaClientInitializationError(
      'Authentication failed',
      '6.19.3',
      'P1000',
    );
    const connect = jest.spyOn(service, '$connect').mockRejectedValue(error);

    await expect(service.onModuleInit()).rejects.toBe(error);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
