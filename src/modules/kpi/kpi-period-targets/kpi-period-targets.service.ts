import { HttpStatus, Injectable } from '@nestjs/common';
import type { PayrollPeriodStatus } from '@prisma/client';
import { AuditLogService } from '../../audit/audit-log.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import { assertPeriodOpenForDataEntry } from '../../../common/utils/period-stage.util';
import type { PutKpiPeriodTargetDto } from './dto/kpi-period-target.dto';

@Injectable()
export class KpiPeriodTargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async listForPeriod(periodId: number) {
    await this.assertPeriodExists(periodId);
    const targets = await this.prisma.kpiPeriodTarget.findMany({
      where: { payrollPeriodId: periodId },
      include: { kpiItem: { include: { kpiGroup: true } } },
      orderBy: [
        { kpiItem: { kpiGroup: { name: 'asc' } } },
        { kpiItem: { sortOrder: 'asc' } },
      ],
    });
    return targets.map((target) => ({
      id: target.id,
      payrollPeriodId: target.payrollPeriodId,
      kpiItemId: target.kpiItemId,
      kpiItemCode: target.kpiItem.code,
      kpiItemName: target.kpiItem.name,
      kpiItemUnit: target.kpiItem.unit,
      kpiGroupId: target.kpiItem.kpiGroup.id,
      kpiGroupCode: target.kpiItem.kpiGroup.code,
      kpiGroupName: target.kpiItem.kpiGroup.name,
      targetValue: target.targetValue,
      createdByUserId: target.createdByUserId,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    }));
  }

  /** Idempotent: gọi lại nhiều lần với cùng target chỉ ghi đè, không tạo trùng (UNIQUE constraint). */
  async setTarget(
    periodId: number,
    kpiItemId: number,
    dto: PutKpiPeriodTargetDto,
    actorUserId: string,
  ) {
    const period = await this.assertPeriodExists(periodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenForDataEntry(period, 'đặt mục tiêu KPI của kỳ');
    await this.assertItemExists(kpiItemId);

    const existing = await this.prisma.kpiPeriodTarget.findUnique({
      where: {
        kpiItemId_payrollPeriodId: { kpiItemId, payrollPeriodId: periodId },
      },
    });

    return this.prisma.$transaction(async (tx) => {
      const target = await tx.kpiPeriodTarget.upsert({
        where: {
          kpiItemId_payrollPeriodId: { kpiItemId, payrollPeriodId: periodId },
        },
        create: {
          kpiItemId,
          payrollPeriodId: periodId,
          targetValue: dto.targetValue,
          createdByUserId: actorUserId,
        },
        update: {
          targetValue: dto.targetValue,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: existing
          ? 'KPI_PERIOD_TARGET_UPDATED'
          : 'KPI_PERIOD_TARGET_CREATED',
        entityType: 'KpiPeriodTarget',
        entityId: target.id,
        payrollPeriodId: periodId,
        beforeData: existing
          ? { targetValue: existing.targetValue.toNumber() }
          : undefined,
        afterData: { kpiItemId, targetValue: dto.targetValue },
      });
      return target;
    });
  }

  private async assertPeriodExists(periodId: number) {
    const period = await this.prisma.payrollPeriod.findUnique({
      where: { id: periodId },
    });
    if (!period) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy kỳ lương',
        HttpStatus.NOT_FOUND,
      );
    }
    return period;
  }

  private assertPeriodEditable(period: { status: PayrollPeriodStatus }) {
    if (period.status === 'CLOSED') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Kỳ lương đã đóng, không thể thay đổi target KPI',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertItemExists(kpiItemId: number) {
    const item = await this.prisma.kpiItem.findUnique({
      where: { id: kpiItemId },
    });
    if (!item) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy đầu mục KPI',
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
