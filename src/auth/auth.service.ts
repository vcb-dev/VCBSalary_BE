import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import type { AuthUserPayload, JwtPayload } from './types';

type DbUser = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
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
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    const matched = await bcrypt.compare(dto.password, user.password);
    if (!matched) {
      throw new UnauthorizedException('Email hoặc mật khẩu không đúng');
    }

    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token không hợp lệ');
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token không hợp lệ');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.user);
  }

  async logout(refreshToken?: string) {
    if (refreshToken) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { success: true };
  }

  meFromPayload(user: AuthUserPayload) {
    return user;
  }

  validateJwtPayload(payload: JwtPayload): AuthUserPayload {
    if (!payload?.sub || !payload.email || !payload.role) {
      throw new UnauthorizedException('Phiên đăng nhập không hợp lệ');
    }
    return {
      id: payload.sub,
      email: payload.email,
      fullName: payload.fullName ?? '',
      role: payload.role,
    };
  }

  private async issueTokens(user: DbUser) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    };

    const accessExpires = this.config.get<string>('JWT_ACCESS_EXPIRES', '15m');
    const refreshToken = randomBytes(48).toString('hex');
    const refreshDays = this.parseDays(
      this.config.get<string>('JWT_REFRESH_EXPIRES', '7d'),
    );

    const [accessToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        expiresIn: accessExpires as `${number}m` | `${number}d` | `${number}h`,
      }),
      this.prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: this.hashToken(refreshToken),
          expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000),
        },
      }),
    ]);

    void this.prisma.refreshToken
      .deleteMany({
        where: {
          userId: user.id,
          OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
        },
      })
      .catch(() => undefined);

    return {
      accessToken,
      refreshToken,
      user: this.meFromPayload({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
      }),
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
