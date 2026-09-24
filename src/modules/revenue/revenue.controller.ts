import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../common/types/auth-user.types';
import { ListRevenueQueryDto, PutEmployeeRevenueDto } from './dto/revenue.dto';
import { RevenueService } from './revenue.service';

const VIEW_PERMISSIONS = [
  'revenue.view_self',
  'revenue.view_team',
  'revenue.view_all',
];

@Controller('payroll-periods')
export class RevenueController {
  constructor(private readonly revenueService: RevenueService) {}

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get(':periodId/revenue')
  list(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Query() query: ListRevenueQueryDto,
  ) {
    return this.revenueService.list(user.id, periodId, query);
  }

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get(':periodId/employees/:employeeId/revenue')
  getForEmployee(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.revenueService.getForEmployee(user.id, periodId, employeeId);
  }

  @RequirePermission('revenue.write')
  @Put(':periodId/employees/:employeeId/revenue')
  upsert(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: PutEmployeeRevenueDto,
  ) {
    return this.revenueService.upsert(user.id, periodId, employeeId, dto);
  }
}
