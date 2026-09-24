import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../common/types/auth-user.types';
import {
  CreateKpiOkrProposalDto,
  RejectProposalDto,
} from './dto/kpi-okr-proposal.dto';
import { KpiOkrProposalsService } from './kpi-okr-proposals.service';

@Controller('kpi-okr-proposals')
export class KpiOkrProposalsController {
  constructor(
    private readonly kpiOkrProposalsService: KpiOkrProposalsService,
  ) {}

  // Mở cho mọi user đăng nhập — không có permission `proposal.view_*` riêng trong catalog, service
  // tự lọc theo scope kpi/okr tương ứng proposalType + luôn thấy đề xuất do chính mình gửi.
  @Get()
  list(@CurrentUser() user: AuthUserPayload) {
    return this.kpiOkrProposalsService.list(user.id);
  }

  @Get(':id')
  getOne(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.kpiOkrProposalsService.getOne(user.id, id);
  }

  @RequirePermission('okr.propose')
  @Post()
  create(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: CreateKpiOkrProposalDto,
  ) {
    return this.kpiOkrProposalsService.create(user.id, dto);
  }

  // Không có permission riêng cho việc duyệt proposal trong catalog — dùng OR cả 2 quyền duyệt
  // Leader hiện có (kpi.leader_approve/okr.leader_approve), khớp đúng loại đề xuất tương ứng.
  @RequirePermission('kpi.leader_approve', 'okr.leader_approve')
  @Post(':id/approve')
  approve(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.kpiOkrProposalsService.approve(user.id, id);
  }

  @RequirePermission('kpi.leader_approve', 'okr.leader_approve')
  @Post(':id/reject')
  reject(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectProposalDto,
  ) {
    return this.kpiOkrProposalsService.reject(user.id, id, dto);
  }
}
