import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { AuditModule } from '../audit/audit.module';
import { DepartmentsController } from './departments/departments.controller';
import { DepartmentsService } from './departments/departments.service';
import { EmployeeGroupsController } from './employee-groups/employee-groups.controller';
import { EmployeeGroupsService } from './employee-groups/employee-groups.service';
import { EmployeesController } from './employees/employees.controller';
import { EmployeesService } from './employees/employees.service';
import { AutomationGenVideoClient } from '../../common/clients/automation-gen-video.client';
import { OrganizationSyncController } from './organization-sync/organization-sync.controller';
import { OrganizationSyncService } from './organization-sync/organization-sync.service';
import { TeamsController } from './teams/teams.controller';
import { TeamsService } from './teams/teams.service';

@Module({
  imports: [AccessControlModule, AuditModule],
  controllers: [
    DepartmentsController,
    EmployeeGroupsController,
    TeamsController,
    EmployeesController,
    OrganizationSyncController,
  ],
  providers: [
    DepartmentsService,
    EmployeeGroupsService,
    TeamsService,
    EmployeesService,
    AutomationGenVideoClient,
    OrganizationSyncService,
  ],
  exports: [
    DepartmentsService,
    EmployeeGroupsService,
    TeamsService,
    EmployeesService,
    AutomationGenVideoClient,
  ],
})
export class OrganizationModule {}
