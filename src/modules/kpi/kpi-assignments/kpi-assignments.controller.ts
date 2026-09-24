import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import {
  CreateKpiAssignmentDto,
  ListKpiAssignmentsQueryDto,
} from './dto/kpi-assignment.dto';
import { KpiAssignmentsService } from './kpi-assignments.service';

@Controller('payroll-periods')
export class KpiAssignmentsController {
  constructor(private readonly kpiAssignmentsService: KpiAssignmentsService) {}

  @Get(':periodId/kpi-assignments')
  listForPeriod(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Query() query: ListKpiAssignmentsQueryDto,
  ) {
    return this.kpiAssignmentsService.listForPeriod(
      user.id,
      periodId,
      query.employeeId,
      query.teamId,
    );
  }

  @RequirePermission('kpi.assign')
  @Post(':periodId/kpi-assignments')
  create(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Body() dto: CreateKpiAssignmentDto,
  ) {
    return this.kpiAssignmentsService.create(user.id, periodId, dto);
  }

  @RequirePermission('kpi.assign')
  @Delete(':periodId/kpi-assignments/:assignmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  cancel(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('assignmentId', ParseIntPipe) assignmentId: number,
  ) {
    return this.kpiAssignmentsService.cancel(user.id, periodId, assignmentId);
  }
}
