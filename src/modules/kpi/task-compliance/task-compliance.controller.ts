import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import { TaskComplianceQueryDto } from './dto/task-compliance-query.dto';
import { TaskComplianceService } from './task-compliance.service';

@Controller()
export class TaskComplianceController {
  constructor(private readonly taskComplianceService: TaskComplianceService) {}

  @Get('payroll-periods/:periodId/employees/:employeeId/task-compliance')
  getTaskCompliance(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Query() query: TaskComplianceQueryDto,
  ) {
    return this.taskComplianceService.getForEmployee(
      user.id,
      periodId,
      employeeId,
      query,
    );
  }
}
