import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { FilesModule } from '../files/files.module';
import { OrganizationModule } from '../organization/organization.module';
import {
  EmployeeTrafficRecordsController,
  PayrollPeriodTrafficController,
} from './traffic.controller';
import { TrafficService } from './traffic.service';
import { TrafficSyncController } from './traffic-sync/traffic-sync.controller';
import { TrafficSyncService } from './traffic-sync/traffic-sync.service';

@Module({
  imports: [AccessControlModule, AuditModule, FilesModule, OrganizationModule],
  controllers: [
    PayrollPeriodTrafficController,
    EmployeeTrafficRecordsController,
    TrafficSyncController,
  ],
  providers: [TrafficService, TrafficSyncService],
  exports: [TrafficService],
})
export class TrafficModule {}
