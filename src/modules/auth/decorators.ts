import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { AuthUserPayload } from './types';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUserPayload => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthUserPayload }>();
    return request.user;
  },
);
