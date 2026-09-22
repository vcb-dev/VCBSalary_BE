import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { BaseSalaryController } from './base-salary/base-salary.controller';
import { BaseSalaryService } from './base-salary/base-salary.service';
import { KpiRewardRatesController } from './kpi-reward-rates/kpi-reward-rates.controller';
import { KpiRewardRatesService } from './kpi-reward-rates/kpi-reward-rates.service';
import { RewardRuleSetsController } from './reward-rule-sets/reward-rule-sets.controller';
import { RewardRuleSetsService } from './reward-rule-sets/reward-rule-sets.service';

@Module({
  imports: [AccessControlModule, AuditModule],
  controllers: [
    RewardRuleSetsController,
    BaseSalaryController,
    KpiRewardRatesController,
  ],
  providers: [RewardRuleSetsService, BaseSalaryService, KpiRewardRatesService],
  exports: [RewardRuleSetsService, BaseSalaryService, KpiRewardRatesService],
})
export class RewardConfigModule {}
