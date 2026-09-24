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
} from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../common/types/auth-user.types';
import {
  CreateEmployeeOkrDto,
  LeaderRejectOkrDto,
  OverrideEmployeeOkrDto,
  UpdateEmployeeOkrDto,
} from './dto/employee-okr.dto';
import { EmployeeOkrsService } from './employee-okrs.service';

/**
 * Không đặt prefix ở cấp class: OKR có 2 nhóm đường dẫn — theo kỳ + nhân sự (`payroll-periods/...`)
 * và theo id bản ghi (`employee-okrs/...`) — nhưng dùng chung một service, nên gom về một controller
 * và để mỗi route tự khai báo đường dẫn đầy đủ. Đường dẫn công khai giữ nguyên như trước.
 */
@Controller()
export class EmployeeOkrsController {
  constructor(private readonly employeeOkrsService: EmployeeOkrsService) {}

  // Mở cho mọi user đăng nhập — service tự kiểm tra scope (self/team/all) theo okr.view_*,
  // giống endpoint kpi-profile của KpiActualsController (không dùng guard permission ở đây).
  @Get('payroll-periods/:periodId/employees/:employeeId/okrs')
  listForEmployee(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.employeeOkrsService.listForEmployee(
      user.id,
      periodId,
      employeeId,
    );
  }

  @RequirePermission('okr.create')
  @Post('payroll-periods/:periodId/employees/:employeeId/okrs')
  create(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateEmployeeOkrDto,
  ) {
    return this.employeeOkrsService.create(user.id, periodId, employeeId, dto);
  }

  @RequirePermission('okr.update_self')
  @Patch('employee-okrs/:id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeOkrDto,
  ) {
    return this.employeeOkrsService.update(user.id, id, dto);
  }

  // Xóa OKR tạo nhầm khi còn DRAFT — dùng lại quyền `okr.create` (đối xứng với việc tạo), service
  // tự kiểm tra scope + trạng thái DRAFT.
  @RequirePermission('okr.create')
  @Delete('employee-okrs/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.employeeOkrsService.remove(user.id, id);
  }

  @RequirePermission('okr.self_confirm')
  @Post('employee-okrs/:id/self-confirm')
  selfConfirm(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.employeeOkrsService.selfConfirm(user.id, id);
  }

  @RequirePermission('okr.leader_approve')
  @Post('employee-okrs/:id/leader-approve')
  leaderApprove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.employeeOkrsService.leaderApprove(user.id, id);
  }

  @RequirePermission('okr.leader_approve')
  @Post('employee-okrs/:id/leader-reject')
  leaderReject(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LeaderRejectOkrDto,
  ) {
    return this.employeeOkrsService.leaderReject(user.id, id, dto);
  }

  @RequirePermission('okr.leader_approve')
  @Post('employee-okrs/:id/override')
  override(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: OverrideEmployeeOkrDto,
  ) {
    return this.employeeOkrsService.override(user.id, id, dto);
  }
}
