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
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import { BaseSalaryService } from './base-salary.service';
import { EmployeeIdsQueryDto } from '../dto/employee-ids-query.dto';
import {
  CreateBaseSalaryHistoryDto,
  UpdateBaseSalaryHistoryDto,
} from './dto/base-salary-history.dto';

/**
 * Không đặt prefix ở cấp class: lương cơ bản có 2 nhóm đường dẫn — theo nhân sự
 * (`employees/:employeeId/base-salary-history`) và theo id bản ghi (`base-salary-histories/...`) —
 * nhưng dùng chung một service, nên gom về một controller và để mỗi route khai báo đường dẫn đầy
 * đủ. Đường dẫn công khai giữ nguyên như trước.
 */
@Controller()
export class BaseSalaryController {
  constructor(private readonly baseSalaryService: BaseSalaryService) {}

  @RequirePermission('base_salary.view')
  @Get('employees/:employeeId/base-salary-history')
  list(@Param('employeeId', ParseIntPipe) employeeId: number) {
    return this.baseSalaryService.list(employeeId);
  }

  @RequirePermission('base_salary.manage')
  @Post('employees/:employeeId/base-salary-history')
  create(
    @CurrentUser() user: AuthUserPayload,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateBaseSalaryHistoryDto,
  ) {
    return this.baseSalaryService.create(employeeId, dto, user.id);
  }

  /**
   * Mức lương cơ bản đang hiệu lực của nhiều nhân sự trong một lần gọi — cho bảng cấu hình ở FE.
   * Khai báo trước các route `base-salary-histories/:id` để 'current' không bị nuốt thành tham số.
   */
  @RequirePermission('base_salary.view')
  @Get('base-salary-histories/current')
  listCurrent(@Query() query: EmployeeIdsQueryDto) {
    return this.baseSalaryService.listCurrentByEmployees(query.employeeIds);
  }

  @RequirePermission('base_salary.manage')
  @Patch('base-salary-histories/:id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBaseSalaryHistoryDto,
  ) {
    return this.baseSalaryService.update(id, dto, user.id);
  }
}
