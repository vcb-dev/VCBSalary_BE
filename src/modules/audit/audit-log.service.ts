import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  type NotificationEventInput,
  NotificationsService,
} from '../notifications/notifications.service';
import { isAuditedAction } from './audit-policy';

export interface RecordAuditLogInput extends NotificationEventInput {
  /** Dùng cho batch lớn: vẫn ghi audit từng bản ghi nhưng gom notification gửi một lần sau batch. */
  suppressNotification?: boolean;
}

/**
 * Ghi audit trong cùng transaction với nghiệp vụ và phát notification từ các domain event quan
 * trọng. Phần truy vấn/lọc/xuất CSV được tách sang AuditQueryService để write path luôn gọn.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Nhận `db` là PrismaService hoặc transaction client — cho phép gọi bên trong
   * `$transaction(async (tx) => ...)` của nghiệp vụ gọi nó (vd. mở kỳ lương) để đảm bảo audit
   * log ghi cùng lúc, cùng thành công/thất bại với thao tác chính.
   */
  async record(
    db: PrismaService | Prisma.TransactionClient,
    input: RecordAuditLogInput,
  ) {
    if (!isAuditedAction(input.action)) {
      if (!input.suppressNotification) {
        await this.notifications.fromAuditEvents(db, [input]);
      }
      return null;
    }
    const teamSnapshots = await this.resolveTeamSnapshots(db, input);
    const created = await db.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        entityId: String(input.entityId),
        targetEmployeeId: input.targetEmployeeId,
        payrollPeriodId: input.payrollPeriodId,
        ...teamSnapshots,
        beforeData: input.beforeData,
        afterData: input.afterData,
        reason: input.reason,
      },
    });
    if (!input.suppressNotification) {
      await this.notifications.fromAuditEvents(db, [input]);
    }
    return created;
  }

  /** Ghi nhiều audit event trong một round-trip, dùng cho nghiệp vụ cập nhật theo lô. */
  async recordMany(
    db: PrismaService | Prisma.TransactionClient,
    inputs: RecordAuditLogInput[],
  ) {
    if (inputs.length === 0) return Promise.resolve({ count: 0 });
    const auditedInputs = inputs.filter((input) =>
      isAuditedAction(input.action),
    );
    if (auditedInputs.length === 0) {
      await this.notify(db, inputs);
      return { count: 0 };
    }
    // Các event cùng thao tác nghiệp vụ (ví dụ SALARY_APPROVED + SALARY_LOCKED) thường có
    // cùng actor/target/kỳ. Chỉ resolve snapshot team một lần thay vì lặp 4 truy vấn cho mỗi event.
    const snapshotCache = new Map<
      string,
      ReturnType<AuditLogService['resolveTeamSnapshots']>
    >();
    const rows: Prisma.AuditLogCreateManyInput[] = await Promise.all(
      auditedInputs.map(async (input) => {
        const cacheKey = `${input.actorUserId}|${input.targetEmployeeId ?? ''}|${input.payrollPeriodId ?? ''}`;
        let snapshots = snapshotCache.get(cacheKey);
        if (!snapshots) {
          snapshots = this.resolveTeamSnapshots(db, input);
          snapshotCache.set(cacheKey, snapshots);
        }
        return {
          actorUserId: input.actorUserId,
          action: input.action,
          entityType: input.entityType,
          entityId: String(input.entityId),
          targetEmployeeId: input.targetEmployeeId,
          payrollPeriodId: input.payrollPeriodId,
          ...(await snapshots),
          beforeData: input.beforeData,
          afterData: input.afterData,
          reason: input.reason,
        };
      }),
    );
    const created = await db.auditLog.createMany({
      data: rows,
    });
    await this.notify(db, inputs);
    return created;
  }

  notify(
    db: PrismaService | Prisma.TransactionClient,
    inputs: RecordAuditLogInput[],
  ) {
    const notifiable = inputs.filter((input) => !input.suppressNotification);
    if (notifiable.length === 0) return Promise.resolve({ count: 0 });
    return this.notifications.fromAuditEvents(db, notifiable);
  }

  private async resolveTeamSnapshots(
    db: PrismaService | Prisma.TransactionClient,
    input: RecordAuditLogInput,
  ) {
    const [actor, target] = await Promise.all([
      db.user.findUnique({
        where: { id: input.actorUserId },
        select: { employeeId: true, employee: { select: { teamId: true } } },
      }),
      input.targetEmployeeId
        ? db.employee.findUnique({
            where: { id: input.targetEmployeeId },
            select: { teamId: true },
          })
        : null,
    ]);
    const [actorPeriodSnapshot, targetPeriodSnapshot] = await Promise.all([
      input.payrollPeriodId && actor?.employeeId
        ? db.payrollPeriodEmployeeSnapshot.findUnique({
            where: {
              payrollPeriodId_employeeId: {
                payrollPeriodId: input.payrollPeriodId,
                employeeId: actor.employeeId,
              },
            },
            select: { teamIdSnapshot: true },
          })
        : null,
      input.payrollPeriodId && input.targetEmployeeId
        ? db.payrollPeriodEmployeeSnapshot.findUnique({
            where: {
              payrollPeriodId_employeeId: {
                payrollPeriodId: input.payrollPeriodId,
                employeeId: input.targetEmployeeId,
              },
            },
            select: { teamIdSnapshot: true },
          })
        : null,
    ]);

    return {
      actorTeamIdSnapshot:
        actorPeriodSnapshot?.teamIdSnapshot ?? actor?.employee?.teamId ?? null,
      targetTeamIdSnapshot:
        targetPeriodSnapshot?.teamIdSnapshot ?? target?.teamId ?? null,
    };
  }
}
