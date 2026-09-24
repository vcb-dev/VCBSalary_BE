import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type PayrollPeriodStatus } from '@prisma/client';
import { AuthorizationService } from '../access-control/authorization.service';
import { PeriodScopeService } from '../access-control/period-scope.service';
import { AuditLogService } from '../audit/audit-log.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginate, toSkipTake } from '../../common/utils/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  ListRevenueQueryDto,
  PutEmployeeRevenueDto,
} from './dto/revenue.dto';

const revenueRecordInclude = {
  enteredBy: { select: { id: true, fullName: true } },
  updatedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.EmployeeRevenueRecordInclude;

type RevenueRecordWithActors = Prisma.EmployeeRevenueRecordGetPayload<{
  include: typeof revenueRecordInclude;
}>;

type RevenueSnapshot = {
  employeeId: number;
  payrollPeriodId: number;
  employeeCodeSnapshot: string;
  employeeNameSnapshot: string;
  jobTitleSnapshot: string;
  teamIdSnapshot: number | null;
  teamNameSnapshot: string | null;
};

@Injectable()
export class RevenueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditLog: AuditLogService,
    private readonly periodScope: PeriodScopeService = new PeriodScopeService(
      prisma,
    ),
  ) {}

  /**
   * Danh sách lấy từ snapshot của kỳ thay vì chỉ lấy record đã nhập. Nhờ vậy UI luôn hiển thị
   * được cả nhân sự còn thiếu doanh thu, đồng thời tên/team lịch sử không bị thay đổi theo hồ sơ
   * nhân sự hiện tại.
   */
  async list(userId: string, periodId: number, query: ListRevenueQueryDto) {
    const scope = await this.authorization.resolveScope(userId, 'revenue');
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;

    const scopeWhere = this.periodScope.snapshotWhere(scope, selfEmployeeId);
    const filterWhere: Prisma.PayrollPeriodEmployeeSnapshotWhereInput = {
      teamIdSnapshot: query.teamId,
      OR: query.search
        ? [
            {
              employeeNameSnapshot: {
                contains: query.search,
                mode: 'insensitive',
              },
            },
            {
              employeeCodeSnapshot: {
                contains: query.search,
                mode: 'insensitive',
              },
            },
          ]
        : undefined,
    };
    const where: Prisma.PayrollPeriodEmployeeSnapshotWhereInput = {
      payrollPeriodId: periodId,
      AND: [scopeWhere, filterWhere],
    };
    const { skip, take } = toSkipTake(query.page, query.pageSize);

    // Kiểm tra kỳ chạy song song với truy vấn danh sách; kỳ không tồn tại vẫn trả 404 như cũ.
    const [, snapshots, total] = await Promise.all([
      this.assertPeriodExists(periodId),
      this.prisma.payrollPeriodEmployeeSnapshot.findMany({
        where,
        skip,
        take,
        orderBy: { employeeNameSnapshot: 'asc' },
        include: {
          employee: {
            select: {
              revenueRecords: {
                where: { payrollPeriodId: periodId },
                take: 1,
                include: revenueRecordInclude,
              },
            },
          },
        },
      }),
      this.prisma.payrollPeriodEmployeeSnapshot.count({ where }),
    ]);

    return paginate(
      snapshots.map((snapshot) =>
        this.toResponse(snapshot, snapshot.employee.revenueRecords[0] ?? null),
      ),
      total,
      query.page,
      query.pageSize,
    );
  }

  async getForEmployee(userId: string, periodId: number, employeeId: number) {
    await this.assertPeriodExists(periodId);
    const snapshot = await this.getSnapshotOrThrow(periodId, employeeId);
    await this.assertVisible(userId, periodId, employeeId);
    const record = await this.prisma.employeeRevenueRecord.findUnique({
      where: {
        employeeId_payrollPeriodId: { employeeId, payrollPeriodId: periodId },
      },
      include: revenueRecordInclude,
    });
    return this.toResponse(snapshot, record);
  }

  /** Upsert idempotent theo UNIQUE(employee_id, payroll_period_id). */
  async upsert(
    actorUserId: string,
    periodId: number,
    employeeId: number,
    dto: PutEmployeeRevenueDto,
  ) {
    const period = await this.assertPeriodExists(periodId);
    this.assertPeriodEditable(period);
    const snapshot = await this.getSnapshotOrThrow(periodId, employeeId);
    const scope = await this.authorization.resolvePermissionScope(
      actorUserId,
      'revenue.write',
    );
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(actorUserId)
        : null;
    const inScope = await this.periodScope.includesEmployee(
      scope,
      periodId,
      employeeId,
      selfEmployeeId,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi nhập doanh thu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
    const existing = await this.prisma.employeeRevenueRecord.findUnique({
      where: {
        employeeId_payrollPeriodId: { employeeId, payrollPeriodId: periodId },
      },
    });
    const amount = new Prisma.Decimal(dto.officialRevenueAmount);

    const record = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.employeeRevenueRecord.upsert({
        where: {
          employeeId_payrollPeriodId: {
            employeeId,
            payrollPeriodId: periodId,
          },
        },
        create: {
          employeeId,
          payrollPeriodId: periodId,
          officialRevenueAmount: amount,
          enteredByUserId: actorUserId,
        },
        update: {
          officialRevenueAmount: amount,
          updatedByUserId: actorUserId,
        },
        include: revenueRecordInclude,
      });

      await this.auditLog.record(tx, {
        actorUserId,
        action: existing ? 'REVENUE_UPDATED' : 'REVENUE_CREATED',
        entityType: 'EmployeeRevenueRecord',
        entityId: saved.id,
        targetEmployeeId: employeeId,
        payrollPeriodId: periodId,
        beforeData: existing
          ? {
              officialRevenueAmount: existing.officialRevenueAmount.toFixed(0),
            }
          : undefined,
        afterData: { officialRevenueAmount: amount.toFixed(0) },
      });
      return saved;
    });

    return this.toResponse(snapshot, record);
  }

  private async assertVisible(
    userId: string,
    periodId: number,
    employeeId: number,
  ) {
    const scope = await this.authorization.resolveScope(userId, 'revenue');
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;
    const inScope = await this.periodScope.includesEmployee(
      scope,
      periodId,
      employeeId,
      selfEmployeeId,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu doanh thu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
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
        'Kỳ lương đã đóng, không thể thay đổi doanh thu',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async getSnapshotOrThrow(periodId: number, employeeId: number) {
    const snapshot = await this.prisma.payrollPeriodEmployeeSnapshot.findUnique(
      {
        where: {
          payrollPeriodId_employeeId: { payrollPeriodId: periodId, employeeId },
        },
      },
    );
    if (!snapshot) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự không thuộc kỳ lương này',
        HttpStatus.BAD_REQUEST,
      );
    }
    return snapshot;
  }

  private toResponse(
    snapshot: RevenueSnapshot,
    record: RevenueRecordWithActors | null,
  ) {
    const lastUpdatedBy = record?.updatedBy ?? record?.enteredBy ?? null;
    return {
      id: record?.id ?? null,
      employeeId: snapshot.employeeId,
      payrollPeriodId: snapshot.payrollPeriodId,
      employeeCode: snapshot.employeeCodeSnapshot,
      employeeName: snapshot.employeeNameSnapshot,
      jobTitle: snapshot.jobTitleSnapshot,
      teamId: snapshot.teamIdSnapshot,
      teamName: snapshot.teamNameSnapshot,
      officialRevenueAmount: record?.officialRevenueAmount.toFixed(0) ?? null,
      enteredBy: record?.enteredBy ?? null,
      enteredAt: record?.enteredAt ?? null,
      lastUpdatedBy,
      updatedAt: record?.updatedAt ?? null,
    };
  }
}
