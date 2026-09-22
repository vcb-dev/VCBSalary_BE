import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { PermissionsService } from './permissions.service';

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @RequirePermission('permission.view')
  @Get()
  list() {
    return this.permissionsService.list();
  }
}
