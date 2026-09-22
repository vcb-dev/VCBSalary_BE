import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import type { AuthUserPayload, JwtPayload } from './types';

type DbUser = {
  id: string;
  email: string;
  passwordHash: string;
  status: UserStatus;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      throw new AppException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Email hoặc mật khẩu không đúng',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new AppException(
        ErrorCode.AUTH_ACCOUNT_DISABLED,
        'Tài khoản đã bị khóa hoặc vô hiệu hóa',
        HttpStatus.FORBIDDEN,
      );
    }

    const matched = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matched) {
      throw new AppException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Email hoặc mật khẩu không đúng',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return this.issueTokens(user, { updateLastLogin: true });
  }

  async refresh(refreshToken: string) {
    if (!refreshToken) {
      throw new AppException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Refresh token không hợp lệ',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const tokenHash = this.hashToken(refreshToken);
    const user = await this.prisma.user.findUnique({
      where: { refreshTokenHash: tokenHash },
    });

    if (
      !user?.refreshTokenExpiresAt ||
      user.refreshTokenExpiresAt <= new Date()
    ) {
      throw new AppException(
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Refresh token không hợp lệ',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new AppException(
        ErrorCode.AUTH_ACCOUNT_DISABLED,
        'Tài khoản đã bị khóa hoặc vô hiệu hóa',
        HttpStatus.FORBIDDEN,
      );
    }

    return this.issueTokens(user, {
      // Điều kiện này làm thao tác rotate mang tính atomic: hai request dùng cùng token cũ
      // không thể đồng thời sinh ra hai refresh token hợp lệ.
      expectedRefreshTokenHash: tokenHash,
    });
  }

  async logout(refreshToken?: string) {
    if (refreshToken) {
      await this.prisma.user.updateMany({
        where: { refreshTokenHash: this.hashToken(refreshToken) },
        data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
      });
    }
    return { success: true };
  }

  async validateJwtPayload(payload: JwtPayload): Promise<AuthUserPayload> {
    if (!payload?.sub || !payload.email) {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Phiên đăng nhập không hợp lệ',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, status: true },
    });
    if (!user) {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Phiên đăng nhập không còn hợp lệ',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new AppException(
        ErrorCode.AUTH_ACCOUNT_DISABLED,
        'Tài khoản đã bị khóa hoặc vô hiệu hóa',
        HttpStatus.FORBIDDEN,
      );
    }
    return { id: user.id, email: user.email };
  }

  private async issueTokens(
    user: DbUser,
    options: {
      expectedRefreshTokenHash?: string;
      updateLastLogin?: boolean;
    } = {},
  ) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
    };

    const accessExpires = this.config.get<string>('JWT_ACCESS_EXPIRES', '15m');
    const refreshToken = randomBytes(48).toString('hex');
    const refreshDays = this.parseDays(
      this.config.get<string>('JWT_REFRESH_EXPIRES', '7d'),
    );
    const now = new Date();
    const refreshTokenHash = this.hashToken(refreshToken);
    const refreshTokenExpiresAt = new Date(
      now.getTime() + refreshDays * 24 * 60 * 60 * 1000,
    );

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      expiresIn: accessExpires as `${number}m` | `${number}d` | `${number}h`,
    });

    if (options.expectedRefreshTokenHash) {
      const rotated = await this.prisma.user.updateMany({
        where: {
          id: user.id,
          status: UserStatus.ACTIVE,
          refreshTokenHash: options.expectedRefreshTokenHash,
          refreshTokenExpiresAt: { gt: now },
        },
        data: {
          refreshTokenHash,
          refreshTokenExpiresAt,
        },
      });
      if (rotated.count !== 1) {
        throw new AppException(
          ErrorCode.AUTH_INVALID_CREDENTIALS,
          'Refresh token không hợp lệ',
          HttpStatus.UNAUTHORIZED,
        );
      }
    } else {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          refreshTokenHash,
          refreshTokenExpiresAt,
          lastLoginAt: options.updateLastLogin ? now : undefined,
        },
      });
    }

    return {
      accessToken,
      refreshToken,
      userId: user.id,
    };
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseDays(value: string) {
    const match = /^(\d+)d$/i.exec(value.trim());
    return match ? Number(match[1]) : 7;
  }
}
