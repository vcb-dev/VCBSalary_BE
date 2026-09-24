import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import {
  LeaderRejectKpiDto,
  ManualKpiActualDto,
  OverrideKpiActualDto,
  UpdateEmployeeKpiActualDto,
} from './dto/kpi-actual.dto';
import { KpiActualsService } from './kpi-actuals.service';

@Controller()
export class KpiActualsController {
  constructor(private readonly kpiActualsService: KpiActualsService) {}

  @Get('payroll-periods/:periodId/employees/:employeeId/kpi-profile')
  getProfile(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.kpiActualsService.getProfile(user.id, periodId, employeeId);
  }

  @RequirePermission('kpi.self_confirm')
  @Put('employee-kpi-actuals/:id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeKpiActualDto,
  ) {
    return this.kpiActualsService.updateActual(user.id, id, dto);
  }

  @RequirePermission('kpi.self_confirm')
  @Post('employee-kpi-actuals/:id/self-confirm')
  selfConfirm(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.kpiActualsService.selfConfirm(user.id, id);
  }

  @RequirePermission('kpi.override')
  @Post('employee-kpi-actuals/:id/manual-entry')
  manualEntry(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ManualKpiActualDto,
  ) {
    return this.kpiActualsService.manualEntry(user.id, id, dto);
  }

  @RequirePermission('kpi.override')
  @Post('employee-kpi-actuals/:id/override')
  override(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: OverrideKpiActualDto,
  ) {
    return this.kpiActualsService.override(user.id, id, dto);
  }

  @RequirePermission('kpi.leader_approve')
  @Post(
    'kpi-groups/:groupId/employees/:employeeId/periods/:periodId/leader-approve',
  )
  approve(
    @CurrentUser() user: AuthUserPayload,
    @Param('groupId', ParseIntPipe) groupId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    return this.kpiActualsService.leaderApprove(
      user.id,
      groupId,
      employeeId,
      periodId,
      teamId,
    );
  }

  @RequirePermission('kpi.leader_approve')
  @Post(
    'kpi-groups/:groupId/employees/:employeeId/periods/:periodId/leader-reject',
  )
  reject(
    @CurrentUser() user: AuthUserPayload,
    @Param('groupId', ParseIntPipe) groupId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Body() dto: LeaderRejectKpiDto,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    return this.kpiActualsService.leaderReject(
      user.id,
      groupId,
      employeeId,
      periodId,
      dto,
      teamId,
    );
  }
}
