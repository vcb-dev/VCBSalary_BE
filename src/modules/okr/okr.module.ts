import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { EmployeeOkrsController } from './employee-okrs.controller';
import { EmployeeOkrsService } from './employee-okrs.service';

@Module({
  imports: [AccessControlModule, AuditModule],
  controllers: [EmployeeOkrsController],
  providers: [EmployeeOkrsService],
  exports: [EmployeeOkrsService],
})
export class OkrModule {}
