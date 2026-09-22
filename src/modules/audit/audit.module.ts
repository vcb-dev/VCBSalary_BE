import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditController } from './audit.controller';
import { AuditLogService } from './audit-log.service';
import { AuditQueryService } from './audit-query.service';

@Module({
  imports: [AccessControlModule, NotificationsModule],
  controllers: [AuditController],
  providers: [AuditLogService, AuditQueryService],
  exports: [AuditLogService],
})
export class AuditModule {}
