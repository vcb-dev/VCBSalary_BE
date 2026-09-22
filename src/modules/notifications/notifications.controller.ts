import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermission } from '../access-control/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators';
import type { AuthUserPayload } from '../auth/types';
import { ListNotificationsQueryDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

@RequirePermission('notification.view_self')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUserPayload,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notifications.list(user.id, query);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUserPayload) {
    return this.notifications.unreadCount(user.id);
  }

  @Post('read-all')
  markAllRead(@CurrentUser() user: AuthUserPayload) {
    return this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  markRead(
    @CurrentUser() user: AuthUserPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.notifications.markRead(user.id, id);
  }
}
