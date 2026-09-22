import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { AuthorizationService } from '../authorization.service';
import { REQUIRED_PERMISSION_KEY } from '../decorators/require-permission.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<
      string[] | undefined
    >(REQUIRED_PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { id: string } }>();
    const userId = request.user?.id;

    if (!userId) {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'Yêu cầu đăng nhập',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const granted = await this.authorization.hasAnyPermission(
      userId,
      requiredPermissions,
    );
    if (!granted) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Không đủ quyền để thực hiện thao tác này',
        HttpStatus.FORBIDDEN,
        { requiredPermissions },
      );
    }

    return true;
  }
}
