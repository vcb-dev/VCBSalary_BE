import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { OrganizationModule } from '../organization/organization.module';
import { KpiAssignmentsController } from './kpi-assignments/kpi-assignments.controller';
import { KpiAssignmentsService } from './kpi-assignments/kpi-assignments.service';
import { KpiActualsController } from './kpi-actuals/kpi-actuals.controller';
import { KpiActualsService } from './kpi-actuals/kpi-actuals.service';
import { KpiGroupsController } from './kpi-groups/kpi-groups.controller';
import { KpiGroupsService } from './kpi-groups/kpi-groups.service';
import { KpiPeriodTargetsController } from './kpi-period-targets/kpi-period-targets.controller';
import { KpiPeriodTargetsService } from './kpi-period-targets/kpi-period-targets.service';
import { KpiSyncController } from './kpi-sync/kpi-sync.controller';
import { KpiSyncService } from './kpi-sync/kpi-sync.service';
import { EmployeeKpiTargetsController } from './kpi-employee-targets/kpi-employee-targets.controller';
import { EmployeeKpiTargetsService } from './kpi-employee-targets/kpi-employee-targets.service';
import { TaskComplianceController } from './task-compliance/task-compliance.controller';
import { TaskComplianceService } from './task-compliance/task-compliance.service';

@Module({
  imports: [AccessControlModule, AuditModule, OrganizationModule],
  controllers: [
    KpiGroupsController,
    KpiPeriodTargetsController,
    EmployeeKpiTargetsController,
    KpiAssignmentsController,
    KpiActualsController,
    KpiSyncController,
    TaskComplianceController,
  ],
  providers: [
    KpiGroupsService,
    KpiPeriodTargetsService,
    EmployeeKpiTargetsService,
    KpiAssignmentsService,
    KpiActualsService,
    KpiSyncService,
    TaskComplianceService,
  ],
  exports: [
    KpiGroupsService,
    KpiPeriodTargetsService,
    EmployeeKpiTargetsService,
    KpiAssignmentsService,
    KpiActualsService,
  ],
})
export class KpiModule {}
