import {
  Body,
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
import { TriggerTrafficSyncDto } from './dto/traffic-sync.dto';
import { TrafficSyncService } from './traffic-sync.service';

@Controller('traffic-sync-runs')
export class TrafficSyncController {
  constructor(private readonly service: TrafficSyncService) {}

  @RequirePermission('sync.trigger')
  @Post()
  trigger(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: TriggerTrafficSyncDto,
  ) {
    return this.service.sync(dto, user.id);
  }

  @RequirePermission('sync.view')
  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Query() query: PaginationQueryDto,
  ) {
    return this.service.list(query, user.id);
  }

  // Khai báo trước ':id' để "teams" không bị ParseUUIDPipe bắt nhầm.
  @RequirePermission('sync.trigger')
  @Get('teams')
  listSyncableTeams(@CurrentUser() user: AuthUserPayload) {
    return this.service.listSyncableTeams(user.id);
  }

  @RequirePermission('sync.view')
  @Get(':id')
  get(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.get(id, user.id);
  }
}
