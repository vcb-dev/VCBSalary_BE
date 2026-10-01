import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PaginationQueryDto } from '../../../common/utils/pagination.dto';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import { CreateUserDto, SetUserRolesDto, UpdateUserDto } from './dto/users.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @RequirePermission('user.manage')
  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.usersService.list(query, user.id);
  }

  @RequirePermission('user.manage')
  @Post()
  create(@CurrentUser() user: AuthUserPayload, @Body() dto: CreateUserDto) {
    return this.usersService.create(dto, user.id);
  }

  @RequirePermission('user.manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.update(id, dto, user.id);
  }

  @RequirePermission('user.manage')
  @Put(':id/roles')
  setRoles(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserRolesDto,
  ) {
    return this.usersService.setRoles(id, dto, user.id);
  }
}
