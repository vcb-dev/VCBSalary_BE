import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
} from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import { PutKpiPeriodTargetDto } from './dto/kpi-period-target.dto';
import { KpiPeriodTargetsService } from './kpi-period-targets.service';

@Controller('payroll-periods')
export class KpiPeriodTargetsController {
  constructor(
    private readonly kpiPeriodTargetsService: KpiPeriodTargetsService,
  ) {}

  @Get(':periodId/kpi-targets')
  listForPeriod(@Param('periodId', ParseIntPipe) periodId: number) {
    return this.kpiPeriodTargetsService.listForPeriod(periodId);
  }

  @RequirePermission('kpi.configure')
  @Put(':periodId/kpi-items/:kpiItemId/target')
  setTarget(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('kpiItemId', ParseIntPipe) kpiItemId: number,
    @Body() dto: PutKpiPeriodTargetDto,
  ) {
    return this.kpiPeriodTargetsService.setTarget(
      periodId,
      kpiItemId,
      dto,
      user.id,
    );
  }
}
