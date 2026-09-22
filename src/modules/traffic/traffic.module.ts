import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { FilesModule } from '../files/files.module';
import {
  EmployeeTrafficRecordsController,
  PayrollPeriodTrafficController,
} from './traffic.controller';
import { TrafficService } from './traffic.service';

@Module({
  imports: [AccessControlModule, AuditModule, FilesModule],
  controllers: [
    PayrollPeriodTrafficController,
    EmployeeTrafficRecordsController,
  ],
  providers: [TrafficService],
  exports: [TrafficService],
})
export class TrafficModule {}
