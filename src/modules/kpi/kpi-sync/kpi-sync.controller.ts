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
import { RequirePermission } from '../../access-control/decorators/require-permission.decorator';
import { CurrentUser } from '../../auth/decorators';
import type { AuthUserPayload } from '../../auth/types';
import { TriggerKpiSyncDto } from './dto/kpi-sync.dto';
import { KpiSyncService } from './kpi-sync.service';

@Controller('kpi-sync-runs')
export class KpiSyncController {
  constructor(private readonly service: KpiSyncService) {}

  @RequirePermission('sync.trigger')
  @Post()
  trigger(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: TriggerKpiSyncDto,
  ) {
    return this.service.sync(dto, user.id);
  }

  @RequirePermission('sync.view')
  @Get()
  list(@Query() query: PaginationQueryDto) {
    return this.service.list(query);
  }

  @RequirePermission('sync.view')
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }
}
