import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CookieAuthService } from './cookie-auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LoginRateLimitService } from './login-rate-limit.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({}),
    AccessControlModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    CookieAuthService,
    JwtStrategy,
    LoginRateLimitService,
  ],
  exports: [AuthService, JwtModule, CookieAuthService],
})
export class AuthModule {}
