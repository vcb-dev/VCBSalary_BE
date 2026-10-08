import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { TrafficPlatform } from '@prisma/client';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../common/types/auth-user.types';
import {
  CustomTrafficDto,
  LeaderRejectTrafficDto,
  ListTrafficQueryDto,
  PutEmployeeTrafficDto,
} from './dto/traffic.dto';
import { TrafficService } from './traffic.service';

const VIEW_PERMISSIONS = [
  'traffic.view_self',
  'traffic.view_team',
  'traffic.view_all',
];
const WRITE_PERMISSIONS = ['traffic.write_self', 'traffic.write_team'];

@Controller('payroll-periods')
export class PayrollPeriodTrafficController {
  constructor(private readonly trafficService: TrafficService) {}

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get(':periodId/traffic')
  list(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Query() query: ListTrafficQueryDto,
  ) {
    return this.trafficService.list(user.id, periodId, query);
  }

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get(':periodId/employees/:employeeId/traffic')
  getForEmployee(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.trafficService.getForEmployee(user.id, periodId, employeeId);
  }

  @RequirePermission(...WRITE_PERMISSIONS)
  @Post(':periodId/employees/:employeeId/traffic/custom')
  createCustom(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CustomTrafficDto,
  ) {
    return this.trafficService.createCustom(user.id, periodId, employeeId, dto);
  }

  @RequirePermission(...WRITE_PERMISSIONS)
  @Put(':periodId/employees/:employeeId/traffic/:platform')
  upsert(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('platform', new ParseEnumPipe(TrafficPlatform))
    platform: TrafficPlatform,
    @Body() dto: PutEmployeeTrafficDto,
  ) {
    return this.trafficService.upsert(
      user.id,
      periodId,
      employeeId,
      platform,
      dto,
    );
  }
}

@Controller('employee-traffic-records')
export class EmployeeTrafficRecordsController {
  constructor(private readonly trafficService: TrafficService) {}

  @RequirePermission(...WRITE_PERMISSIONS)
  @Put(':id')
  updateCustom(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CustomTrafficDto,
  ) {
    return this.trafficService.updateCustom(user.id, id, dto);
  }

  @RequirePermission(...WRITE_PERMISSIONS)
  @Delete(':id')
  deleteCustom(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.trafficService.deleteCustom(user.id, id);
  }

  @RequirePermission('traffic.write_self')
  @Post(':id/self-confirm')
  selfConfirm(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.trafficService.selfConfirm(user.id, id);
  }

  @RequirePermission('traffic.leader_approve')
  @Post(':id/leader-approve')
  leaderApprove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.trafficService.leaderApprove(user.id, id);
  }

  @RequirePermission('traffic.leader_approve')
  @Post(':id/leader-reject')
  leaderReject(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LeaderRejectTrafficDto,
  ) {
    return this.trafficService.leaderReject(user.id, id, dto);
  }
}
