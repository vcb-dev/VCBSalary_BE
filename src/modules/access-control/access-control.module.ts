import { Module } from '@nestjs/common';
import { AuthorizationService } from './authorization.service';
import { PeriodScopeService } from './period-scope.service';
import { PermissionsController } from './permissions/permissions.controller';
import { PermissionsService } from './permissions/permissions.service';
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

@Module({
  controllers: [RolesController, PermissionsController, UsersController],
  providers: [
    AuthorizationService,
    PeriodScopeService,
    RolesService,
    PermissionsService,
    UsersService,
  ],
  exports: [AuthorizationService, PeriodScopeService, UsersService],
})
export class AccessControlModule {}
