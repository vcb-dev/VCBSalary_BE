import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../common/types/auth-user.types';
import { PaginationQueryDto } from '../../common/utils/pagination.dto';
import {
  CreatePayrollPeriodDto,
  ListPayrollPeriodsQueryDto,
  UpdatePayrollPeriodDto,
} from './dto/payroll-period.dto';
import { PayrollPeriodsService } from './payroll-periods.service';

@Controller('payroll-periods')
export class PayrollPeriodsController {
  constructor(private readonly payrollPeriodsService: PayrollPeriodsService) {}

  @Get()
  list(@Query() query: ListPayrollPeriodsQueryDto) {
    return this.payrollPeriodsService.list(query);
  }

  @Get('years')
  listYears() {
    return this.payrollPeriodsService.listYears();
  }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.payrollPeriodsService.getOrThrow(id);
  }

  @RequirePermission('payroll_period.manage')
  @Post()
  create(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: CreatePayrollPeriodDto,
  ) {
    return this.payrollPeriodsService.create(dto, user.id);
  }

  @RequirePermission('payroll_period.manage')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePayrollPeriodDto,
  ) {
    return this.payrollPeriodsService.update(id, dto, user.id);
  }

  // Tiền kiểm dữ liệu nhân sự trước khi mở kỳ / đồng bộ — trả về danh sách người còn thiếu
  // team chính hoặc lệch tỷ trọng KPI, để Admin sửa trước thay vì bấm nút rồi nhận lỗi.
  @RequirePermission('payroll_period.manage')
  @Get(':id/employee-readiness')
  getEmployeeReadiness(@Param('id', ParseIntPipe) id: number) {
    return this.payrollPeriodsService.getEmployeeReadiness(id);
  }

  @RequirePermission('payroll_period.manage')
  @Post(':id/open')
  open(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.payrollPeriodsService.open(id, user.id);
  }

  // Thêm nhân sự mới (tạo sau khi kỳ đã mở) vào snapshot — không đụng nhân sự đã snapshot.
  @RequirePermission('payroll_period.manage')
  @Post(':id/sync-employee-snapshots')
  syncEmployeeSnapshots(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.payrollPeriodsService.syncEmployeeSnapshots(id, user.id);
  }

  @RequirePermission('payroll_period.manage')
  @Post(':id/start-review')
  startReview(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.payrollPeriodsService.startReview(id, user.id);
  }

  @RequirePermission('payroll_period.manage')
  @Post(':id/close')
  close(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.payrollPeriodsService.close(id, user.id);
  }

  @RequirePermission('payroll_period.manage')
  @Get(':id/employee-snapshots')
  listEmployeeSnapshots(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PaginationQueryDto,
  ) {
    return this.payrollPeriodsService.listEmployeeSnapshots(id, query);
  }
}
