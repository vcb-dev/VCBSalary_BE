import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUserPayload } from '../../common/types/auth-user.types';
import { AuditQueryService } from './audit-query.service';
import {
  ExportAuditLogsQueryDto,
  ListAuditLogsQueryDto,
} from './dto/audit.dto';

const VIEW_PERMISSIONS = [
  'audit.view_self',
  'audit.view_team',
  'audit.view_all',
];

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditQuery: AuditQueryService) {}

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Query() query: ListAuditLogsQueryDto,
  ) {
    return this.auditQuery.list(user.id, query);
  }

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get('export')
  async export(
    @CurrentUser() user: AuthUserPayload,
    @Query() query: ExportAuditLogsQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const csv = await this.auditQuery.exportCsv(user.id, query);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return csv;
  }

  @RequirePermission(...VIEW_PERMISSIONS)
  @Get(':id')
  getOne(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.auditQuery.getOne(user.id, id);
  }
}
