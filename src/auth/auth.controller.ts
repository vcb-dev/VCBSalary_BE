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
import { AuthService } from './auth.service';
import { CookieAuthService } from './cookie-auth.service';
import { COOKIE_REFRESH } from './cookie.constants';
import { CurrentUser, Public } from './decorators';
import { LoginDto } from './dto/login.dto';
import type { AuthUserPayload } from './types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: CookieAuthService,
  ) {}

  /** Email + mật khẩu → set HttpOnly cookies (không trả token trong JSON) */
  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto);
    this.cookies.setAuthCookies(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
    return { user: result.user };
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
    return { user: result.user };
  }

  @Public()
  @HttpCode(200)
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[COOKIE_REFRESH] as string | undefined;
    await this.authService.logout(refreshToken);
    this.cookies.clearAuthCookies(res);
    return { success: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUserPayload) {
    return this.authService.meFromPayload(user);
  }
}
