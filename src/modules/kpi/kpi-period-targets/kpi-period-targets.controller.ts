import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
} from '@nestjs/common';
import { RequirePermission } from '../../access-control/decorators/require-permission.decorator';
import { CurrentUser } from '../../auth/decorators';
import type { AuthUserPayload } from '../../auth/types';
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
