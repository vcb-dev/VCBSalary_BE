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
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import { CreateKpiGroupDto, UpdateKpiGroupDto } from './dto/kpi-group.dto';
import { CreateKpiItemDto, UpdateKpiItemDto } from './dto/kpi-item.dto';
import { KpiGroupsService } from './kpi-groups.service';

@Controller()
export class KpiGroupsController {
  constructor(private readonly kpiGroupsService: KpiGroupsService) {}

  @Get('kpi-groups')
  list() {
    return this.kpiGroupsService.list();
  }

  @Get('kpi-groups/:id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.kpiGroupsService.getOrThrow(id);
  }

  @RequirePermission('kpi.configure')
  @Post('kpi-groups')
  create(@CurrentUser() user: AuthUserPayload, @Body() dto: CreateKpiGroupDto) {
    return this.kpiGroupsService.create(dto, user.id);
  }

  @RequirePermission('kpi.configure')
  @Patch('kpi-groups/:id')
  update(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateKpiGroupDto,
  ) {
    return this.kpiGroupsService.update(id, dto, user.id);
  }

  // Xóa cứng nhóm KPI — chỉ dành cho nhóm tạo nhầm, chưa phát sinh dữ liệu. Quyền `kpi.delete_group`
  // mặc định chỉ ADMIN có (LEADER có `kpi.configure` nhưng KHÔNG có quyền này), đúng yêu cầu
  // "chỉ admin được xoá". Service tự chặn nếu nhóm đã có assignment/target/actual/đề xuất.
  @RequirePermission('kpi.delete_group')
  @Delete('kpi-groups/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.kpiGroupsService.remove(id, user.id);
  }

  @RequirePermission('kpi.configure')
  @Post('kpi-groups/:id/items')
  createItem(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateKpiItemDto,
  ) {
    return this.kpiGroupsService.createItem(id, dto, user.id);
  }

  @RequirePermission('kpi.configure')
  @Patch('kpi-items/:id')
  updateItem(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateKpiItemDto,
  ) {
    return this.kpiGroupsService.updateItem(id, dto, user.id);
  }
}
