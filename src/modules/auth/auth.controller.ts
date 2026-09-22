import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { UsersService } from '../access-control/users/users.service';
import { AuthService } from './auth.service';
import { CookieAuthService } from './cookie-auth.service';
import { COOKIE_REFRESH } from './cookie.constants';
import { CurrentUser, Public } from './decorators';
import { LoginDto } from './dto/login.dto';
import { LoginRateLimitService } from './login-rate-limit.service';
import type { AuthUserPayload } from './types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly cookies: CookieAuthService,
    private readonly loginRateLimit: LoginRateLimitService,
  ) {}

  /** Email + mật khẩu → set HttpOnly cookies (không trả token trong JSON) */
  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rateLimitKey = `${req.ip ?? req.socket.remoteAddress ?? 'unknown'}:${dto.email.toLowerCase()}`;
    this.loginRateLimit.assertAllowed(rateLimitKey);
    let result: Awaited<ReturnType<AuthService['login']>>;
    try {
      result = await this.authService.login(dto);
    } catch (error) {
      if (
        error instanceof AppException &&
        error.code === ErrorCode.AUTH_INVALID_CREDENTIALS
      ) {
        this.loginRateLimit.recordFailure(rateLimitKey);
      }
      throw error;
    }
    this.loginRateLimit.reset(rateLimitKey);
    this.cookies.setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return { user: await this.usersService.getProfile(result.userId) };
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[COOKIE_REFRESH] as string | undefined;
    const result = await this.authService.refresh(refreshToken ?? '');
    this.cookies.setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return { user: await this.usersService.getProfile(result.userId) };
  }

  @Public()
  @HttpCode(200)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[COOKIE_REFRESH] as string | undefined;
    await this.authService.logout(refreshToken);
    this.cookies.clearAuthCookies(res);
    return { success: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUserPayload) {
    return this.usersService.getProfile(user.id);
  }
}
