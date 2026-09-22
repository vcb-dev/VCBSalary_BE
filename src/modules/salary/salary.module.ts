import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import {
  PayrollPeriodSalaryController,
  SalaryRecordsController,
} from './salary.controller';
import { SalaryService } from './salary.service';

@Module({
  imports: [AccessControlModule, AuditModule],
  controllers: [PayrollPeriodSalaryController, SalaryRecordsController],
  providers: [SalaryService],
  exports: [SalaryService],
})
export class SalaryModule {}
