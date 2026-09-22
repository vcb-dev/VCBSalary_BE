import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { KpiOkrProposalsController } from './kpi-okr-proposals.controller';
import { KpiOkrProposalsService } from './kpi-okr-proposals.service';

/**
 * Đề xuất thêm đầu mục KPI hoặc OKR (`kpi_okr_proposals`). Tách khỏi OkrModule vì bảng này phục vụ
 * cả hai loại (`ProposalType = KPI_ITEM | OKR`) và có vòng đời riêng — PENDING/APPROVED/REJECTED —
 * trước khi entity thật được tạo.
 */
@Module({
  imports: [AccessControlModule, AuditModule],
  controllers: [KpiOkrProposalsController],
  providers: [KpiOkrProposalsService],
  exports: [KpiOkrProposalsService],
})
export class KpiOkrProposalsModule {}
