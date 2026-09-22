import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { PayrollPeriodsController } from './payroll-periods.controller';
import { PayrollPeriodsService } from './payroll-periods.service';

@Module({
  imports: [AccessControlModule, AuditModule],
  controllers: [PayrollPeriodsController],
  providers: [PayrollPeriodsService],
  exports: [PayrollPeriodsService],
})
export class PayrollPeriodsModule {}
