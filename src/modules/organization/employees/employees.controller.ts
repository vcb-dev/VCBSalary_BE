import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Delete,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import {
  CreateEmployeeDto,
  UpdateEmployeeDto,
  UpsertEmployeeTeamMembershipDto,
} from './dto/employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import { EmployeesService } from './employees.service';

const VIEW_PERMISSIONS = [
  'employee.view_self',
  'employee.view_team',
  'employee.view_all',
];

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Query() query: ListEmployeesQueryDto,
  ) {
    return this.employeesService.list(user.id, query);
  }

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get(':id')
  getOne(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.employeesService.getOne(user.id, id);
  }

  @RequirePermission('employee.manage')
  @Post()
  create(@CurrentUser() user: AuthUserPayload, @Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto, user.id);
  }

  @RequirePermission('employee.manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(id, dto, user.id);
  }

  @RequirePermission('employee.manage')
  @Post(':id/team-memberships')
  upsertMembership(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertEmployeeTeamMembershipDto,
  ) {
    return this.employeesService.upsertMembership(id, dto, user.id);
  }

  @RequirePermission('employee.manage')
  @Delete(':id/team-memberships/:teamId')
  deactivateMembership(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    return this.employeesService.deactivateMembership(id, teamId, user.id);
  }
}
