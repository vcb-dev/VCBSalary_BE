import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PERMISSION_KEY = 'requiredPermission';

/** Cho phép truyền nhiều permission code — pass nếu user có ÍT NHẤT MỘT trong số đó. */
export const RequirePermission = (...permissionCodes: string[]) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permissionCodes);
