import { createHash } from 'crypto';
import { UserStatus } from '@prisma/client';
import { ErrorCode } from '../../../common/errors/error-codes';
import { AuthService } from '../auth.service';

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function makeService() {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const jwt = {
    signAsync: jest.fn().mockResolvedValue('access-token'),
  };
  const config = {
    get: jest.fn((_key: string, fallback: string) => fallback),
    getOrThrow: jest.fn().mockReturnValue('jwt-secret'),
  };
  const service = new AuthService(
    prisma as never,
    jwt as never,
    config as never,
  );
  return { service, prisma, jwt };
}

function activeUser(refreshToken: string) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'user@example.com',
    passwordHash: 'password-hash',
    status: UserStatus.ACTIVE,
    refreshTokenHash: sha256(refreshToken),
    refreshTokenExpiresAt: new Date(Date.now() + 60_000),
  };
}

function firstCallArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0]?.[0] as T;
}

describe('AuthService refresh token rotation', () => {
  it('rotates a valid token atomically on the user row', async () => {
    const { service, prisma } = makeService();
    const oldToken = 'old-refresh-token';
    prisma.user.findUnique.mockResolvedValue(activeUser(oldToken));
    prisma.user.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.refresh(oldToken);

    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).not.toBe(oldToken);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { refreshTokenHash: sha256(oldToken) },
    });
    const update = firstCallArg<{
      where: {
        id: string;
        status: UserStatus;
        refreshTokenHash: string;
        refreshTokenExpiresAt: { gt: Date };
      };
      data: { refreshTokenHash: string; refreshTokenExpiresAt: Date };
    }>(prisma.user.updateMany);
    expect(update.where).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      status: UserStatus.ACTIVE,
      refreshTokenHash: sha256(oldToken),
    });
    expect(update.where.refreshTokenExpiresAt.gt).toBeInstanceOf(Date);
    expect(typeof update.data.refreshTokenHash).toBe('string');
    expect(update.data.refreshTokenExpiresAt).toBeInstanceOf(Date);
  });

  it('rejects a token already consumed by a concurrent refresh', async () => {
    const { service, prisma } = makeService();
    const oldToken = 'already-consumed-token';
    prisma.user.findUnique.mockResolvedValue(activeUser(oldToken));
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refresh(oldToken)).rejects.toMatchObject({
      code: ErrorCode.AUTH_INVALID_CREDENTIALS,
    });
  });

  it('clears both refresh-token fields on logout', async () => {
    const { service, prisma } = makeService();
    prisma.user.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.logout('logout-token')).resolves.toEqual({
      success: true,
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { refreshTokenHash: sha256('logout-token') },
      data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
    });
  });
});

describe('AuthService access-token validation', () => {
  it('loads the current user and accepts only an ACTIVE account', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'current@example.com',
      status: UserStatus.ACTIVE,
    });

    await expect(
      service.validateJwtPayload({ sub: 'u1', email: 'old@example.com' }),
    ).resolves.toEqual({ id: 'u1', email: 'current@example.com' });
  });

  it('rejects an access token immediately after the account is disabled', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'user@example.com',
      status: UserStatus.DISABLED,
    });

    await expect(
      service.validateJwtPayload({ sub: 'u1', email: 'user@example.com' }),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_ACCOUNT_DISABLED });
  });
});
