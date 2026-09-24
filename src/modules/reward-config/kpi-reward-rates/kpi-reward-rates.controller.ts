import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import { EmployeeIdsQueryDto } from '../dto/employee-ids-query.dto';
import {
  CreateKpiRewardRateDto,
  UpdateKpiRewardRateDto,
} from './dto/kpi-reward-rate.dto';
import { KpiRewardRatesService } from './kpi-reward-rates.service';

/**
 * Không đặt prefix ở cấp class: mức tiền KPI có 2 nhóm đường dẫn — theo nhân sự
 * (`employees/:employeeId/kpi-reward-rates`) và theo id bản ghi (`employee-kpi-reward-rates/...`)
 * — nhưng dùng chung một service, nên gom về một controller và để mỗi route khai báo đường dẫn
 * đầy đủ. Đường dẫn công khai giữ nguyên như trước.
 */
@Controller()
export class KpiRewardRatesController {
  constructor(private readonly service: KpiRewardRatesService) {}

  @RequirePermission('kpi_reward_rate.view')
  @Get('employees/:employeeId/kpi-reward-rates')
  list(@Param('employeeId', ParseIntPipe) employeeId: number) {
    return this.service.list(employeeId);
  }

  @RequirePermission('kpi_reward_rate.manage')
  @Post('employees/:employeeId/kpi-reward-rates')
  create(
    @CurrentUser() user: AuthUserPayload,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateKpiRewardRateDto,
  ) {
    return this.service.create(employeeId, dto, user.id);
  }

  /**
   * Mức tiền KPI đang hiệu lực của nhiều nhân sự trong một lần gọi — cho bảng cấu hình ở FE.
   * Khai báo trước các route `employee-kpi-reward-rates/:id` để 'current' không bị nuốt thành
   * tham số route.
   */
  @RequirePermission('kpi_reward_rate.view')
  @Get('employee-kpi-reward-rates/current')
  listCurrent(@Query() query: EmployeeIdsQueryDto) {
    return this.service.listCurrentByEmployees(query.employeeIds);
  }

  @RequirePermission('kpi_reward_rate.manage')
  @Patch('employee-kpi-reward-rates/:id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateKpiRewardRateDto,
  ) {
    return this.service.update(id, dto, user.id);
  }

  @RequirePermission('kpi_reward_rate.manage')
  @Delete('employee-kpi-reward-rates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.remove(id, user.id);
  }
}
