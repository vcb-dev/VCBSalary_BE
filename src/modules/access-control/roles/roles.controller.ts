import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { RequirePermission } from '../decorators/require-permission.decorator';
import { CurrentUser } from '../../auth/decorators';
import type { AuthUserPayload } from '../../auth/types';
import {
  CreateRoleDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from './dto/roles.dto';
import { RolesService } from './roles.service';

@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @RequirePermission('role.view')
  @Get()
  list() {
    return this.rolesService.list();
  }

  @RequirePermission('role.manage')
  @Post()
  create(@CurrentUser() user: AuthUserPayload, @Body() dto: CreateRoleDto) {
    return this.rolesService.create(dto, user.id);
  }

  @RequirePermission('role.manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.rolesService.update(id, dto, user.id);
  }

  @RequirePermission('role.manage')
  @Put(':id/permissions')
  setPermissions(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetRolePermissionsDto,
  ) {
    return this.rolesService.setPermissions(id, dto, user.id);
  }
}
