import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditLogService } from '../../audit/audit-log.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import { addDays, currentBusinessDate } from '../../../common/utils/date.util';
import type {
  CreateBaseSalaryHistoryDto,
  UpdateBaseSalaryHistoryDto,
} from './dto/base-salary-history.dto';

@Injectable()
export class BaseSalaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(employeeId: number) {
    await this.assertEmployeeExists(employeeId);
    return this.prisma.baseSalaryHistory.findMany({
      where: { employeeId },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  /**
   * Tổng hợp mức lương cơ bản ĐANG hiệu lực của nhiều nhân sự trong một lần gọi.
   * Bảng cấu hình ở FE cần hiển thị cả danh sách nhân sự; nếu gọi `list()` cho từng người thì mỗi
   * lần mở trang là hàng chục request. Ở đây chỉ trả mức hiện hành + số bản ghi lịch sử, phần lịch
   * sử đầy đủ vẫn lấy qua `list()` khi người dùng mở chi tiết một người.
   */
  async listCurrentByEmployees(employeeIds?: number[]) {
    const scope =
      employeeIds && employeeIds.length > 0
        ? { employeeId: { in: employeeIds } }
        : {};
    // Khoảng hiệu lực là đoạn ĐÓNG [effectiveFrom, effectiveTo] tính theo ngày nghiệp vụ: mức
    // lương còn hiệu lực đến hết ngày effectiveTo.
    const today = currentBusinessDate();

    const [effectiveEntries, counts] = await Promise.all([
      this.prisma.baseSalaryHistory.findMany({
        where: {
          ...scope,
          effectiveFrom: { lte: today },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
        },
        // Dữ liệu chuẩn chỉ có một khoảng hiệu lực tại một thời điểm; nếu lịch sử bị chồng lấn thì
        // lấy khoảng bắt đầu muộn nhất — đúng với cách `create()` đóng khoảng cũ.
        orderBy: { effectiveFrom: 'asc' },
      }),
      this.prisma.baseSalaryHistory.groupBy({
        by: ['employeeId'],
        where: scope,
        _count: { _all: true },
      }),
    ]);

    const currentByEmployee = new Map<
      number,
      (typeof effectiveEntries)[number]
    >();
    for (const entry of effectiveEntries) {
      currentByEmployee.set(entry.employeeId, entry);
    }

    return counts.map((row) => ({
      employeeId: row.employeeId,
      entryCount: row._count._all,
      current: currentByEmployee.get(row.employeeId) ?? null,
    }));
  }

  /**
   * Tạo bản ghi lương cơ bản mới — đây là khoảng mới nhất (effectiveTo = null), nhưng có thể mới
   * chỉ được lên lịch nếu effectiveFrom ở tương lai. Khoảng trước đó có hiệu lực đến hết ngày liền
   * trước effectiveFrom và được đóng tại đúng ngày đó. V1 chỉ hỗ
   * trợ nhập tuần tự theo thời gian (effectiveFrom phải sau lần thay đổi gần nhất) — chưa hỗ trợ
   * backfill lịch sử có khoảng trống/chèn giữa, vì spec không yêu cầu và tránh phát sinh logic
   * overlap phức tạp không cần thiết ở V1.
   */
  async create(
    employeeId: number,
    dto: CreateBaseSalaryHistoryDto,
    actorUserId: string,
  ) {
    await this.assertEmployeeExists(employeeId);
    const effectiveFrom = new Date(dto.effectiveFrom);

    const latest = await this.prisma.baseSalaryHistory.findFirst({
      where: { employeeId },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (latest && effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'effectiveFrom phải sau lần thay đổi lương cơ bản gần nhất của nhân sự này',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (latest && latest.effectiveTo === null) {
        await tx.baseSalaryHistory.update({
          where: { id: latest.id },
          // effectiveTo là ngày CUỐI CÙNG còn hiệu lực, không phải mốc cắt: mức cũ chạy đến hết
          // ngày liền trước mức mới.
          data: { effectiveTo: addDays(effectiveFrom, -1) },
        });
      }

      const created = await tx.baseSalaryHistory.create({
        data: {
          employeeId,
          monthlyBaseSalary: dto.monthlyBaseSalary,
          effectiveFrom,
          effectiveTo: null,
          createdByUserId: actorUserId,
        },
      });

      await this.auditLog.record(tx, {
        actorUserId,
        action: 'BASE_SALARY_HISTORY_CREATED',
        entityType: 'BaseSalaryHistory',
        entityId: created.id,
        targetEmployeeId: employeeId,
        afterData: {
          monthlyBaseSalary: dto.monthlyBaseSalary,
          effectiveFrom: dto.effectiveFrom,
        },
      });

      return created;
    });
  }

  /**
   * Sửa một bản ghi lịch sử đã có (công cụ đính chính cho Admin). Chưa kiểm tra ràng buộc với
   * salary_records đã snapshot (bảng đó thuộc M12, chưa tồn tại) — cần bổ sung guard này khi
   * M12 triển khai, đúng nguyên tắc "không sửa lịch sử đã được snapshot".
   */
  async update(
    id: number,
    dto: UpdateBaseSalaryHistoryDto,
    actorUserId: string,
  ) {
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
    // Đoạn đóng nên effectiveTo được phép trùng effectiveFrom (mức chỉ hiệu lực đúng một ngày).
    if (nextTo !== null && nextTo.getTime() < nextFrom.getTime()) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'effectiveTo phải bằng hoặc sau effectiveFrom',
        HttpStatus.BAD_REQUEST,
      );
    }

    const siblings = await this.prisma.baseSalaryHistory.findMany({
      where: { employeeId: existing.employeeId, id: { not: id } },
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
        'effectiveFrom mới phải sau ngày bắt đầu của mức lương liền trước',
        HttpStatus.BAD_REQUEST,
      );
    }

    const overlapping = siblings
      .filter((sibling) => sibling.id !== previousAdjacent?.id)
      .find((sibling) => {
        const siblingFrom = sibling.effectiveFrom.getTime();
        const siblingTo = sibling.effectiveTo?.getTime() ?? Infinity;
        const newFrom = nextFrom.getTime();
        const newTo = nextTo?.getTime() ?? Infinity;
        return newFrom <= siblingTo && siblingFrom <= newTo;
      });
    if (overlapping) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Khoảng effectiveFrom/effectiveTo chồng lấn với bản ghi lịch sử khác của nhân sự này',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (previousAdjacent) {
        await tx.baseSalaryHistory.update({
          where: { id: previousAdjacent.id },
          data: { effectiveTo: previousAdjacentTo },
        });
      }

      const updated = await tx.baseSalaryHistory.update({
        where: { id },
        data: {
          monthlyBaseSalary: dto.monthlyBaseSalary,
          effectiveFrom: dto.effectiveFrom ? nextFrom : undefined,
          effectiveTo: dto.effectiveTo !== undefined ? nextTo : undefined,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'BASE_SALARY_HISTORY_UPDATED',
        entityType: 'BaseSalaryHistory',
        entityId: id,
        targetEmployeeId: existing.employeeId,
        beforeData: {
          monthlyBaseSalary: existing.monthlyBaseSalary.toNumber(),
          effectiveFrom: existing.effectiveFrom.toISOString(),
          effectiveTo: existing.effectiveTo?.toISOString() ?? null,
        },
        afterData: { ...dto },
      });
      return updated;
    });
  }

  private async getOrThrow(id: number) {
    const entry = await this.prisma.baseSalaryHistory.findUnique({
      where: { id },
    });
    if (!entry) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy bản ghi lương cơ bản',
        HttpStatus.NOT_FOUND,
      );
    }
    return entry;
  }

  private async assertEmployeeExists(employeeId: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhân sự',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async assertNotSnapshotted(entry: {
    employeeId: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  }) {
    const usedCount = await this.prisma.salaryRecord.count({
      where: {
        employeeId: entry.employeeId,
        status: { in: ['LOCKED', 'SUPERSEDED'] },
        payrollPeriod: {
          endDate: {
            gte: entry.effectiveFrom,
            lte: entry.effectiveTo ?? undefined,
          },
        },
      },
    });
    if (usedCount > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Không thể sửa mức lương cơ bản đã được snapshot vào bản lương đã khóa',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
