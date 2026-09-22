import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import { addDays, currentBusinessDate } from '../../../common/utils/date.util';
import { AuditLogService } from '../../audit/audit-log.service';
import type {
  CreateKpiRewardRateDto,
  UpdateKpiRewardRateDto,
} from './dto/kpi-reward-rate.dto';

const groupSummary = {
  id: true,
  code: true,
  name: true,
  isActive: true,
} as const;

@Injectable()
export class KpiRewardRatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(employeeId: number) {
    await this.assertEmployeeExists(employeeId);
    return this.prisma.employeeKpiRewardRate.findMany({
      where: { employeeId },
      orderBy: [{ effectiveFrom: 'desc' }, { kpiGroup: { name: 'asc' } }],
      include: { kpiGroup: { select: groupSummary } },
    });
  }

  /**
   * Tổng hợp mức tiền KPI ĐANG hiệu lực của nhiều nhân sự trong một lần gọi.
   * Bảng cấu hình ở FE hiển thị cả danh sách nhân sự; gọi `list()` cho từng người sẽ thành hàng
   * chục request mỗi lần mở trang. Lịch sử đầy đủ vẫn lấy qua `list()` khi mở chi tiết một người.
   */
  async listCurrentByEmployees(employeeIds?: number[]) {
    const scope =
      employeeIds && employeeIds.length > 0
        ? { employeeId: { in: employeeIds } }
        : {};
    // Khoảng hiệu lực là đoạn ĐÓNG [effectiveFrom, effectiveTo] tính theo ngày nghiệp vụ: mức
    // tiền còn hiệu lực đến hết ngày effectiveTo.
    const today = currentBusinessDate();

    const [activeRates, counts] = await Promise.all([
      this.prisma.employeeKpiRewardRate.findMany({
        where: {
          ...scope,
          effectiveFrom: { lte: today },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
        },
        orderBy: [{ effectiveFrom: 'asc' }, { kpiGroup: { name: 'asc' } }],
        include: { kpiGroup: { select: groupSummary } },
      }),
      this.prisma.employeeKpiRewardRate.groupBy({
        by: ['employeeId'],
        where: scope,
        _count: { _all: true },
      }),
    ]);

    // Mỗi (nhân sự, nhóm KPI) chỉ có một mức tại một thời điểm; nếu dữ liệu chồng lấn thì lấy
    // khoảng bắt đầu muộn nhất, đúng với cách `create()` đóng khoảng cũ.
    type ActiveRate = (typeof activeRates)[number];
    const ratesByEmployee = new Map<number, Map<number, ActiveRate>>();
    for (const rate of activeRates) {
      const byGroup =
        ratesByEmployee.get(rate.employeeId) ?? new Map<number, ActiveRate>();
      byGroup.set(rate.kpiGroupId, rate);
      ratesByEmployee.set(rate.employeeId, byGroup);
    }

    return counts.map((row) => {
      const rates = [...(ratesByEmployee.get(row.employeeId)?.values() ?? [])];
      const totalRewardAmount = rates
        .reduce(
          (total, rate) => total.add(rate.rewardAmount),
          new Prisma.Decimal(0),
        )
        .toString();

      return {
        employeeId: row.employeeId,
        rateCount: row._count._all,
        activeRates: rates,
        totalRewardAmount,
      };
    });
  }

  /** Resolver cho M12: khoảng hiệu lực là đoạn đóng [effectiveFrom, effectiveTo]. */
  findEffectiveRate(employeeId: number, kpiGroupId: number, effectiveAt: Date) {
    return this.prisma.employeeKpiRewardRate.findFirst({
      where: {
        employeeId,
        kpiGroupId,
        effectiveFrom: { lte: effectiveAt },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveAt } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      include: { kpiGroup: { select: groupSummary } },
    });
  }

  async create(
    employeeId: number,
    dto: CreateKpiRewardRateDto,
    actorUserId: string,
  ) {
    await Promise.all([
      this.assertEmployeeExists(employeeId),
      this.assertKpiGroupExists(dto.kpiGroupId),
    ]);
    const effectiveFrom = new Date(dto.effectiveFrom);
    const latest = await this.prisma.employeeKpiRewardRate.findFirst({
      where: { employeeId, kpiGroupId: dto.kpiGroupId },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (latest && effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'effectiveFrom phải sau lần thay đổi mức tiền KPI gần nhất của nhân sự và nhóm KPI này',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (latest?.effectiveTo === null) {
        await tx.employeeKpiRewardRate.update({
          where: { id: latest.id },
          // effectiveTo là ngày CUỐI CÙNG còn hiệu lực: mức cũ chạy đến hết ngày liền trước mức mới.
          data: { effectiveTo: addDays(effectiveFrom, -1) },
        });
      }

      const created = await tx.employeeKpiRewardRate.create({
        data: {
          employeeId,
          kpiGroupId: dto.kpiGroupId,
          rewardAmount: dto.rewardAmount,
          effectiveFrom,
          createdByUserId: actorUserId,
        },
        include: { kpiGroup: { select: groupSummary } },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_REWARD_RATE_CREATED',
        entityType: 'EmployeeKpiRewardRate',
        entityId: created.id,
        targetEmployeeId: employeeId,
        afterData: {
          kpiGroupId: dto.kpiGroupId,
          rewardAmount: dto.rewardAmount,
          effectiveFrom: dto.effectiveFrom,
        },
      });
      return created;
    });
  }

  async update(id: number, dto: UpdateKpiRewardRateDto, actorUserId: string) {
    const existing = await this.getOrThrow(id);
    await this.assertNotSnapshotted(existing);
    const nextFrom = dto.effectiveFrom
      ? new Date(dto.effectiveFrom)
      : existing.effectiveFrom;
    const nextTo =
      dto.effectiveTo !== undefined
        ? dto.effectiveTo === null
          ? null
          : new Date(dto.effectiveTo)
        : existing.effectiveTo;
    this.assertDateRangeValid(nextFrom, nextTo);

    const siblings = await this.prisma.employeeKpiRewardRate.findMany({
      where: {
        employeeId: existing.employeeId,
        kpiGroupId: existing.kpiGroupId,
        id: { not: id },
      },
    });
    // Mức liền trước đang kết thúc sát ngay trước effectiveFrom cũ phải dịch theo khi sửa
    // effectiveFrom; để nguyên thì timeline thủng (hoặc chồng lấn) đúng bằng đoạn vừa dịch.
    const previousAdjacent =
      nextFrom.getTime() === existing.effectiveFrom.getTime()
        ? undefined
        : siblings.find(
            (sibling) =>
              sibling.effectiveTo !== null &&
              sibling.effectiveTo.getTime() ===
                addDays(existing.effectiveFrom, -1).getTime(),
          );
    const previousAdjacentTo = previousAdjacent ? addDays(nextFrom, -1) : null;
    if (
      previousAdjacent &&
      previousAdjacentTo!.getTime() < previousAdjacent.effectiveFrom.getTime()
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'effectiveFrom mới phải sau ngày bắt đầu của mức tiền KPI liền trước',
        HttpStatus.BAD_REQUEST,
      );
    }

    const overlapping = siblings
      .filter((sibling) => sibling.id !== previousAdjacent?.id)
      .some((sibling) =>
        this.overlaps(
          nextFrom,
          nextTo,
          sibling.effectiveFrom,
          sibling.effectiveTo,
        ),
      );
    if (overlapping) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Khoảng hiệu lực chồng lấn với mức tiền KPI khác của cùng nhân sự và nhóm KPI',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (previousAdjacent) {
        await tx.employeeKpiRewardRate.update({
          where: { id: previousAdjacent.id },
          data: { effectiveTo: previousAdjacentTo },
        });
      }

      const updated = await tx.employeeKpiRewardRate.update({
        where: { id },
        data: {
          rewardAmount: dto.rewardAmount,
          effectiveFrom: dto.effectiveFrom ? nextFrom : undefined,
          effectiveTo: dto.effectiveTo !== undefined ? nextTo : undefined,
        },
        include: { kpiGroup: { select: groupSummary } },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_REWARD_RATE_UPDATED',
        entityType: 'EmployeeKpiRewardRate',
        entityId: id,
        targetEmployeeId: existing.employeeId,
        beforeData: {
          rewardAmount: existing.rewardAmount.toString(),
          effectiveFrom: existing.effectiveFrom.toISOString(),
          effectiveTo: existing.effectiveTo?.toISOString() ?? null,
        },
        afterData: { ...dto },
      });
      return updated;
    });
  }

  async remove(id: number, actorUserId: string) {
    const existing = await this.getOrThrow(id);
    await this.assertNotSnapshotted(existing);
    const previous = await this.prisma.employeeKpiRewardRate.findFirst({
      where: {
        employeeId: existing.employeeId,
        kpiGroupId: existing.kpiGroupId,
        effectiveFrom: { lt: existing.effectiveFrom },
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    await this.prisma.$transaction(async (tx) => {
      // Xóa một lần thay đổi nhập nhầm thì nối lại mức trước đó với mốc kết thúc của bản bị xóa.
      if (previous) {
        await tx.employeeKpiRewardRate.update({
          where: { id: previous.id },
          data: { effectiveTo: existing.effectiveTo },
        });
      }
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_REWARD_RATE_DELETED',
        entityType: 'EmployeeKpiRewardRate',
        entityId: id,
        targetEmployeeId: existing.employeeId,
        beforeData: {
          kpiGroupId: existing.kpiGroupId,
          rewardAmount: existing.rewardAmount.toString(),
          effectiveFrom: existing.effectiveFrom.toISOString(),
          effectiveTo: existing.effectiveTo?.toISOString() ?? null,
        },
        afterData: { restoredPreviousRateId: previous?.id ?? null },
      });
      await tx.employeeKpiRewardRate.delete({ where: { id } });
    });
  }

  private async getOrThrow(id: number) {
    const rate = await this.prisma.employeeKpiRewardRate.findUnique({
      where: { id },
    });
    if (!rate) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy mức tiền KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    return rate;
  }

  private async assertEmployeeExists(employeeId: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhân sự',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async assertKpiGroupExists(kpiGroupId: number) {
    const group = await this.prisma.kpiGroup.findUnique({
      where: { id: kpiGroupId },
      select: { id: true },
    });
    if (!group) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhóm KPI',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private assertDateRangeValid(from: Date, to: Date | null) {
    // Đoạn đóng nên effectiveTo được phép trùng effectiveFrom (mức chỉ hiệu lực đúng một ngày).
    if (to !== null && to.getTime() < from.getTime()) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'effectiveTo phải bằng hoặc sau effectiveFrom',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private overlaps(
    leftFrom: Date,
    leftTo: Date | null,
    rightFrom: Date,
    rightTo: Date | null,
  ) {
    return (
      leftFrom.getTime() <= (rightTo?.getTime() ?? Infinity) &&
      rightFrom.getTime() <= (leftTo?.getTime() ?? Infinity)
    );
  }

  private async assertNotSnapshotted(rate: {
    employeeId: number;
    kpiGroupId: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }) {
    const usedCount = await this.prisma.salaryRecordKpiItem.count({
      where: {
        kpiGroupId: rate.kpiGroupId,
        salaryRecord: {
          employeeId: rate.employeeId,
          status: { in: ['LOCKED', 'SUPERSEDED'] },
          payrollPeriod: {
            endDate: {
              gte: rate.effectiveFrom,
              lte: rate.effectiveTo ?? undefined,
            },
          },
        },
      },
    });
    if (usedCount > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Không thể sửa hoặc xóa mức tiền KPI đã được snapshot vào bản lương đã khóa',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
