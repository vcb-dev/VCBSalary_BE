import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { PaginationQueryDto } from '../../../common/utils/pagination.dto';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../../common/types/auth-user.types';
import { OrganizationSyncService } from './organization-sync.service';

@Controller('organization-sync')
export class OrganizationSyncController {
  constructor(
    private readonly organizationSyncService: OrganizationSyncService,
  ) {}

  @RequirePermission('employee.manage')
  @Post('teams')
  triggerAll(@CurrentUser() user: AuthUserPayload) {
    return this.organizationSyncService.syncAllTeams(user.id);
  }

  @RequirePermission('employee.manage')
  @Post('teams/:externalTeamId')
  trigger(
    @CurrentUser() user: AuthUserPayload,
    @Param('externalTeamId', ParseUUIDPipe) externalTeamId: string,
  ) {
    return this.organizationSyncService.syncTeam(externalTeamId, user.id);
  }

  @RequirePermission('employee.manage')
  @Get('runs')
  listRuns(@Query() query: PaginationQueryDto) {
    return this.organizationSyncService.listRuns(query);
  }

  @RequirePermission('employee.manage')
  @Get('runs/:id')
  getRun(@Param('id', ParseUUIDPipe) id: string) {
    return this.organizationSyncService.getRun(id);
  }
}
