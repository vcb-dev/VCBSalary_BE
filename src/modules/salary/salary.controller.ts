import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../access-control/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserPayload } from '../auth/types';
import {
  CalculateSalaryQueryDto,
  ListSalaryRecordsQueryDto,
} from './dto/salary.dto';
import { SalaryService } from './salary.service';

const VIEW_PERMISSIONS = [
  'salary.view_self',
  'salary.view_team',
  'salary.view_all',
];

@Controller('payroll-periods')
export class PayrollPeriodSalaryController {
  constructor(private readonly salaryService: SalaryService) {}

  @RequirePermission('salary.calculate')
  @Post(':periodId/salaries/calculate')
  calculatePeriod(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Query() query: CalculateSalaryQueryDto,
  ) {
    return this.salaryService.calculatePeriod(user.id, periodId, query.mode);
  }

  @RequirePermission('salary.calculate')
  @Post(':periodId/employees/:employeeId/salary/calculate')
  calculateEmployee(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Query() query: CalculateSalaryQueryDto,
  ) {
    return this.salaryService.calculateEmployee(
      user.id,
      periodId,
      employeeId,
      query.mode,
    );
  }

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get(':periodId/salaries')
  list(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Query() query: ListSalaryRecordsQueryDto,
  ) {
    return this.salaryService.list(user.id, periodId, query);
  }
}

@Controller('salary-records')
export class SalaryRecordsController {
  constructor(private readonly salaryService: SalaryService) {}

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get(':id')
  getOne(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.salaryService.getOne(user.id, id);
  }

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get(':id/breakdown')
  getBreakdown(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.salaryService.getBreakdown(user.id, id);
  }

  @RequirePermission('salary.final_approve')
  @Post(':id/approve')
  approve(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.salaryService.approve(user.id, id);
  }

  @RequirePermission('salary.create_revision')
  @Post(':id/create-revision')
  createRevision(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.salaryService.createRevision(user.id, id);
  }
}
