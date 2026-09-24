import {
  Body,
  Controller,
  Delete,
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
  OverrideEmployeeKpiTargetDto,
  PutEmployeeKpiTargetDto,
} from './dto/employee-kpi-target.dto';
import { EmployeeKpiTargetsService } from './kpi-employee-targets.service';

@Controller('payroll-periods')
export class EmployeeKpiTargetsController {
  constructor(
    private readonly employeeKpiTargetsService: EmployeeKpiTargetsService,
  ) {}

  /** Target theo từng nhân sự. Service kiểm tra thêm scope TEAM/ALL, không cho SELF thao tác. */
  @RequirePermission('kpi.leader_approve')
  @Put(':periodId/employees/:employeeId/kpi-items/:kpiItemId/target')
  setTarget(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('kpiItemId', ParseIntPipe) kpiItemId: number,
    @Body() dto: PutEmployeeKpiTargetDto,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    return this.employeeKpiTargetsService.setTarget(
      user.id,
      periodId,
      employeeId,
      kpiItemId,
      dto,
      teamId,
    );
  }

  @RequirePermission('kpi.override')
  @Post(':periodId/employees/:employeeId/kpi-items/:kpiItemId/target/override')
  overrideTarget(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('kpiItemId', ParseIntPipe) kpiItemId: number,
    @Body() dto: OverrideEmployeeKpiTargetDto,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    return this.employeeKpiTargetsService.overrideTarget(
      user.id,
      periodId,
      employeeId,
      kpiItemId,
      dto,
      teamId,
    );
  }

  @RequirePermission('kpi.override')
  @Delete(
    ':periodId/employees/:employeeId/kpi-items/:kpiItemId/target/override',
  )
  clearOverride(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('kpiItemId', ParseIntPipe) kpiItemId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ) {
    return this.employeeKpiTargetsService.clearOverride(
      user.id,
      periodId,
      employeeId,
      kpiItemId,
      teamId,
    );
  }
}
