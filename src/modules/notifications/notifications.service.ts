import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginate, toSkipTake } from '../../common/utils/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import type { ListNotificationsQueryDto } from './dto/notifications.dto';

export interface NotificationEventInput {
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string | number;
  targetEmployeeId?: number;
  payrollPeriodId?: number;
  beforeData?: Prisma.InputJsonValue;
  afterData?: Prisma.InputJsonValue;
  reason?: string;
}

export interface CreateNotificationInput {
  recipientUserId: string;
  notificationType: string;
  title: string;
  message: string;
  referenceEntityType?: string;
  referenceEntityId?: string | number;
}

type DbClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async createMany(db: DbClient, inputs: CreateNotificationInput[]) {
    if (inputs.length === 0) return { count: 0 };
    const unique = new Map<string, CreateNotificationInput>();
    for (const input of inputs) {
      const key = [
        input.recipientUserId,
        input.notificationType,
        input.referenceEntityType ?? '',
        input.referenceEntityId ?? '',
        input.title,
      ].join('|');
      unique.set(key, input);
    }
    const candidates = [...unique.values()];
    const existing = await db.notification.findMany({
      where: {
        isRead: false,
        OR: candidates.map((input) => ({
          recipientUserId: input.recipientUserId,
          notificationType: input.notificationType,
          referenceEntityType: input.referenceEntityType,
          referenceEntityId:
            input.referenceEntityId == null
              ? null
              : String(input.referenceEntityId),
        })),
      },
      select: {
        recipientUserId: true,
        notificationType: true,
        referenceEntityType: true,
        referenceEntityId: true,
      },
    });
    const existingKeys = new Set(
      existing.map((item) =>
        [
          item.recipientUserId,
          item.notificationType,
          item.referenceEntityType ?? '',
          item.referenceEntityId ?? '',
        ].join('|'),
      ),
    );
    const pending = candidates.filter(
      (input) =>
        !existingKeys.has(
          [
            input.recipientUserId,
            input.notificationType,
            input.referenceEntityType ?? '',
            input.referenceEntityId ?? '',
          ].join('|'),
        ),
    );
    if (pending.length === 0) return { count: 0 };
    return db.notification.createMany({
      data: pending.map((input) => ({
        recipientUserId: input.recipientUserId,
        notificationType: input.notificationType,
        title: input.title,
        message: input.message,
        referenceEntityType: input.referenceEntityType,
        referenceEntityId:
          input.referenceEntityId == null
            ? undefined
            : String(input.referenceEntityId),
      })),
    });
  }

  async list(userId: string, query: ListNotificationsQueryDto) {
    const where: Prisma.NotificationWhereInput = {
      recipientUserId: userId,
      isRead: query.unread === true ? false : undefined,
      notificationType: query.type || undefined,
    };
    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const [rows, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: { recipientUserId: userId, isRead: false },
      }),
    ]);
    return {
      ...paginate(
        rows.map((row) => ({
          ...row,
          href: notificationHref(row.notificationType),
        })),
        total,
        query.page,
        query.pageSize,
      ),
      unreadCount,
    };
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { recipientUserId: userId, isRead: false },
    });
    return { count };
  }

  async markRead(userId: string, id: number) {
    const result = await this.prisma.notification.updateMany({
      where: { id, recipientUserId: userId },
      data: { isRead: true, readAt: new Date() },
    });
    if (result.count === 0) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy thông báo',
        HttpStatus.NOT_FOUND,
      );
    }
    return this.prisma.notification.findUniqueOrThrow({ where: { id } });
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { recipientUserId: userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { updatedCount: result.count };
  }

  /**
   * Chuyển các audit event quan trọng thành notification ngay trong transaction nghiệp vụ.
   * Gom event cùng loại/nhân sự/kỳ để luồng duyệt KPI theo lô chỉ tạo một thông báo.
   */
  async fromAuditEvents(db: DbClient, events: NotificationEventInput[]) {
    const groups = new Map<string, NotificationEventInput>();
    for (const event of events) {
      const key = [
        event.action,
        event.targetEmployeeId ?? '',
        event.payrollPeriodId ?? '',
        event.reason ?? '',
      ].join('|');
      if (!groups.has(key)) groups.set(key, event);
    }

    const notifications: CreateNotificationInput[] = [];
    for (const event of groups.values()) {
      const generated = await this.fromAuditEvent(db, event);
      notifications.push(...generated);
    }
    return this.createMany(db, notifications);
  }

  private async fromAuditEvent(
    db: DbClient,
    event: NotificationEventInput,
  ): Promise<CreateNotificationInput[]> {
    if (REJECTION_EVENTS[event.action] && event.targetEmployeeId) {
      const employee = await this.loadEmployeeRecipients(
        db,
        event.targetEmployeeId,
      );
      if (!employee?.user) return [];
      const meta = REJECTION_EVENTS[event.action];
      return [
        {
          recipientUserId: employee.user.id,
          notificationType: meta.type,
          title: meta.title,
          message: event.reason
            ? `${employee.fullName}: ${event.reason}`
            : `${employee.fullName}: vui lòng kiểm tra và cập nhật lại dữ liệu.`,
          referenceEntityType: event.entityType,
          referenceEntityId: event.entityId,
        },
      ];
    }

    if (WAITING_REVIEW_EVENTS[event.action] && event.targetEmployeeId) {
      const employee = await this.loadEmployeeRecipients(
        db,
        event.targetEmployeeId,
      );
      if (!employee?.leader?.user) return [];
      const meta = WAITING_REVIEW_EVENTS[event.action];
      return [
        {
          recipientUserId: employee.leader.user.id,
          notificationType: meta.type,
          title: meta.title,
          message: `${employee.fullName} đã tự xác nhận và đang chờ bạn duyệt.`,
          referenceEntityType: event.entityType,
          referenceEntityId: event.entityId,
        },
      ];
    }

    if (
      (event.action === 'SALARY_CALCULATED' ||
        event.action === 'SALARY_RECALCULATED' ||
        event.action === 'SALARY_REVISION_CREATED' ||
        event.action === 'SALARY_BATCH_CALCULATED') &&
      jsonField(event.afterData, 'status') === 'PENDING'
    ) {
      const approvers = await db.user.findMany({
        where: {
          status: 'ACTIVE',
          userRoles: {
            some: {
              role: {
                rolePermissions: {
                  some: { permission: { code: 'salary.final_approve' } },
                },
              },
            },
          },
        },
        select: { id: true },
      });
      return approvers.map((approver) => ({
        recipientUserId: approver.id,
        notificationType: 'SALARY_WAITING_APPROVAL',
        title: 'Bản lương chờ duyệt',
        message:
          event.action === 'SALARY_BATCH_CALCULATED'
            ? `${jsonNumber(event.afterData, 'count')} bản lương đã sẵn sàng để kiểm tra và duyệt cuối cùng.`
            : 'Một bản lương đã sẵn sàng để kiểm tra và duyệt cuối cùng.',
        referenceEntityType: event.entityType,
        referenceEntityId: event.entityId,
      }));
    }

    if (event.action === 'SALARY_LOCKED' && event.targetEmployeeId) {
      const employee = await this.loadEmployeeRecipients(
        db,
        event.targetEmployeeId,
      );
      if (!employee?.user) return [];
      return [
        {
          recipientUserId: employee.user.id,
          notificationType: 'SALARY_LOCKED',
          title: 'Bảng lương đã được duyệt',
          message: `${employee.fullName}: bảng lương đã được duyệt và khóa.`,
          referenceEntityType: event.entityType,
          referenceEntityId: event.entityId,
        },
      ];
    }

    if (
      event.action === 'KPI_SYNC_APPLIED' ||
      event.action === 'KPI_SYNC_FAILED'
    ) {
      const status = jsonString(event.afterData, 'status', 'FAILED');
      const conflicts = jsonNumber(event.afterData, 'conflictRecords');
      const failures = jsonNumber(event.afterData, 'failedRecords');
      const warnings = jsonNumber(event.afterData, 'warningCount');
      if (status === 'SUCCESS' && conflicts + failures + warnings === 0)
        return [];
      return [
        {
          recipientUserId: event.actorUserId,
          notificationType:
            status === 'FAILED' ? 'KPI_SYNC_FAILED' : 'KPI_SYNC_WARNING',
          title:
            status === 'FAILED'
              ? 'Đồng bộ KPI thất bại'
              : 'Đồng bộ KPI cần kiểm tra',
          message:
            status === 'FAILED'
              ? jsonString(
                  event.afterData,
                  'error',
                  'Lượt đồng bộ không hoàn thành.',
                )
              : `${conflicts} xung đột, ${failures} lỗi và ${warnings} cảnh báo.`,
          referenceEntityType: event.entityType,
          referenceEntityId: event.entityId,
        },
      ];
    }

    return [];
  }

  private loadEmployeeRecipients(db: DbClient, employeeId: number) {
    return db.employee.findUnique({
      where: { id: employeeId },
      select: {
        fullName: true,
        user: { select: { id: true } },
        leader: { select: { user: { select: { id: true } } } },
      },
    });
  }
}

const REJECTION_EVENTS: Record<string, { type: string; title: string }> = {
  KPI_ACTUAL_LEADER_REJECTED: {
    type: 'KPI_REJECTED',
    title: 'KPI cần chỉnh sửa',
  },
  OKR_LEADER_REJECTED: {
    type: 'OKR_REJECTED',
    title: 'OKR cần chỉnh sửa',
  },
  TRAFFIC_LEADER_REJECTED: {
    type: 'TRAFFIC_REJECTED',
    title: 'Traffic cần chỉnh sửa',
  },
  PROPOSAL_REJECTED: {
    type: 'PROPOSAL_REJECTED',
    title: 'Đề xuất KPI/OKR bị từ chối',
  },
};

const WAITING_REVIEW_EVENTS: Record<string, { type: string; title: string }> = {
  KPI_ACTUAL_SELF_CONFIRMED: {
    type: 'KPI_WAITING_REVIEW',
    title: 'KPI đang chờ duyệt',
  },
  OKR_SELF_CONFIRMED: {
    type: 'OKR_WAITING_REVIEW',
    title: 'OKR đang chờ duyệt',
  },
  TRAFFIC_SELF_CONFIRMED: {
    type: 'TRAFFIC_WAITING_REVIEW',
    title: 'Traffic đang chờ duyệt',
  },
};

function jsonField(value: Prisma.InputJsonValue | undefined, key: string) {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    return undefined;
  return (value as Record<string, unknown>)[key];
}

function jsonString(
  value: Prisma.InputJsonValue | undefined,
  key: string,
  fallback: string,
) {
  const field = jsonField(value, key);
  return typeof field === 'string' ? field : fallback;
}

function jsonNumber(value: Prisma.InputJsonValue | undefined, key: string) {
  const field = jsonField(value, key);
  if (typeof field === 'number') return field;
  if (typeof field === 'string' && /^\d+$/.test(field)) return Number(field);
  return 0;
}

function notificationHref(type: string) {
  if (
    type.startsWith('KPI_') ||
    type.startsWith('OKR_') ||
    type.startsWith('PROPOSAL_')
  ) {
    return '/kpi-okr';
  }
  if (type.startsWith('TRAFFIC_')) return '/traffic-revenue';
  if (type.startsWith('SALARY_')) return '/salary-records';
  if (type.startsWith('KPI_SYNC_')) return '/kpi-sync';
  if (type.startsWith('PAYROLL_')) return '/payroll-periods';
  return '/';
}
