import { HttpStatus, Injectable } from '@nestjs/common';
import {
  PayrollPeriodStatus,
  Prisma,
  SalaryComponentSource,
  SalaryRecordStatus,
} from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { forEachConcurrent } from '../../common/utils/for-each-concurrent';
import { paginate, toSkipTake } from '../../common/utils/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../access-control/authorization.service';
import { PeriodScopeService } from '../access-control/period-scope.service';
import { AuditLogService } from '../audit/audit-log.service';
import {
  SalaryCalculationMode,
  type CreateSalaryBonusDto,
  type ListSalaryRecordsQueryDto,
} from './dto/salary.dto';
import {
  calculateBinaryReward,
  calculateCommission,
  calculatePerformanceGoalProgressPercent,
  calculateProgressPercent,
  calculateRpm,
  roundMoney,
  resolveRevenueBracket,
} from './salary-calculator';
import type {
  CalculatedKpiItem,
  CalculatedOkrItem,
  SalaryCalculation,
  SalaryWarning,
} from './salary.types';

const ZERO = new Prisma.Decimal(0);
const SALARY_BATCH_CONCURRENCY = 6;
const SALARY_TRANSACTION_MAX_WAIT_MS = 10_000;
const SALARY_TRANSACTION_TIMEOUT_MS = 30_000;
const SALARY_BONUS_COMPONENT_CODE = 'BONUS';
// Thưởng thêm chỉ sửa được trên bản nháp; bản đã khóa phải đi qua bản điều chỉnh như mọi khoản khác.
const BONUS_EDITABLE_STATUSES = [
  SalaryRecordStatus.PENDING,
  SalaryRecordStatus.WARNING,
];
type DbClient = Pick<
  Prisma.TransactionClient,
  | 'payrollPeriod'
  | 'payrollPeriodEmployeeSnapshot'
  | 'baseSalaryHistory'
  | 'employeeKpiAssignment'
  | 'employeeKpiRewardRate'
  | 'employeeOkr'
  | 'employeeTrafficRecord'
  | 'employeeRevenueRecord'
  | 'kpiSyncRunItem'
  | 'salaryRecord'
>;

const salaryRecordSummaryInclude = {
  rewardRuleSet: { select: { version: true } },
  revenueRewardBracket: { select: { label: true } },
  calculatedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.SalaryRecordInclude;

const salaryRecordBreakdownInclude = {
  ...salaryRecordSummaryInclude,
  payrollPeriod: { select: { status: true } },
  kpiItems: { orderBy: { id: 'asc' as const } },
  okrItems: { orderBy: { id: 'asc' as const } },
  components: {
    orderBy: { id: 'asc' as const },
    include: { createdBy: { select: { id: true, fullName: true } } },
  },
} satisfies Prisma.SalaryRecordInclude;

type SalaryRecordSummary = Prisma.SalaryRecordGetPayload<{
  include: typeof salaryRecordSummaryInclude;
}>;

type SalaryRecordBreakdown = Prisma.SalaryRecordGetPayload<{
  include: typeof salaryRecordBreakdownInclude;
}>;

@Injectable()
export class SalaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditLog: AuditLogService,
    private readonly periodScope: PeriodScopeService = new PeriodScopeService(
      prisma,
    ),
  ) {}

  async calculateEmployee(
    actorUserId: string,
    periodId: number,
    employeeId: number,
    mode: SalaryCalculationMode,
  ) {
    await this.assertVisibleForPermission(
      actorUserId,
      periodId,
      employeeId,
      'salary.calculate',
    );
    return this.calculateEmployeeAuthorized(
      actorUserId,
      periodId,
      employeeId,
      mode,
    );
  }

  private async calculateEmployeeAuthorized(
    actorUserId: string,
    periodId: number,
    employeeId: number,
    mode: SalaryCalculationMode,
    suppressNotification = false,
  ) {
    if (mode === SalaryCalculationMode.PREVIEW) {
      const calculation = await this.buildCalculation(
        periodId,
        employeeId,
        this.prisma,
      );
      return this.serializeCalculation(calculation, null);
    }
    // Đọc toàn bộ input và ghi snapshot trong cùng một transaction nhất quán. Quan trọng hơn,
    // persistCalculation chỉ claim record khi nó vẫn còn PENDING/WARNING, nên một request tính
    // lại không thể ghi đè hoặc "mở khóa" record vừa được Manager duyệt đồng thời.
    // Trong interactive transaction mọi query chạy tuần tự trên một connection (Promise.all không
    // song song): ~20 round-trip tới Singapore mất 4–8s, vượt timeout mặc định 5s của Prisma.
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const calculation = await this.buildCalculation(
            periodId,
            employeeId,
            tx,
          );
          const recordId = await this.persistCalculation(
            actorUserId,
            calculation,
            tx,
            suppressNotification,
          );
          return {
            id: recordId,
            employeeId: calculation.employeeId,
            payrollPeriodId: calculation.payrollPeriodId,
            status: calculation.status,
            warningCount: calculation.warnings.length,
            warnings: calculation.warnings,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: SALARY_TRANSACTION_MAX_WAIT_MS,
          timeout: SALARY_TRANSACTION_TIMEOUT_MS,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2028' || error.code === 'P2034')
      ) {
        throw new AppException(
          ErrorCode.CONFLICT,
          error.code === 'P2028'
            ? 'Phiên tính lương đã hết hạn, vui lòng thực hiện lại'
            : 'Dữ liệu tính lương vừa thay đổi, vui lòng thực hiện lại',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async calculatePeriod(
    actorUserId: string,
    periodId: number,
    mode: SalaryCalculationMode,
  ) {
    await this.getCalculablePeriod(periodId);
    const scope = await this.authorization.resolvePermissionScope(
      actorUserId,
      'salary.calculate',
    );
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(actorUserId)
        : null;
    const employeeIds = await this.periodScope.resolveEmployeeIds(
      scope,
      periodId,
      selfEmployeeId,
    );
    const snapshots = await this.prisma.payrollPeriodEmployeeSnapshot.findMany({
      where: {
        payrollPeriodId: periodId,
        employeeId: employeeIds === 'ALL' ? undefined : { in: employeeIds },
      },
      select: { employeeId: true },
      orderBy: { employeeNameSnapshot: 'asc' },
    });

    // Batch PERSIST phải giữ nguyên các phiên bản đã khóa. Lọc trước giúp tránh chạy toàn bộ
    // phép tính rồi mới phát hiện record không thể ghi; nhánh catch bên dưới vẫn bảo vệ trường
    // hợp record được duyệt/khóa đồng thời sau truy vấn này.
    const lockedEmployeeIds = new Set<number>();
    if (mode === SalaryCalculationMode.PERSIST && snapshots.length > 0) {
      const latestRecords = await this.prisma.salaryRecord.findMany({
        where: {
          payrollPeriodId: periodId,
          employeeId: { in: snapshots.map((snapshot) => snapshot.employeeId) },
        },
        orderBy: [{ employeeId: 'asc' }, { versionNumber: 'desc' }],
        distinct: ['employeeId'],
        select: { employeeId: true, status: true },
      });
      for (const record of latestRecords) {
        if (
          record.status === SalaryRecordStatus.LOCKED ||
          record.status === SalaryRecordStatus.SUPERSEDED
        ) {
          lockedEmployeeIds.add(record.employeeId);
        }
      }
    }

    const calculableSnapshots = snapshots.filter(
      (snapshot) => !lockedEmployeeIds.has(snapshot.employeeId),
    );

    type CalculationResult = {
      status: SalaryRecordStatus;
      [key: string]: unknown;
    };
    type BatchItemResult = CalculationResult | { skippedLocked: true };
    const data = calculableSnapshots.map(
      (): BatchItemResult | undefined => undefined,
    );
    await forEachConcurrent(
      calculableSnapshots.map((snapshot, index) => ({ snapshot, index })),
      SALARY_BATCH_CONCURRENCY,
      async ({ snapshot, index }) => {
        // Scope của toàn bộ danh sách đã được resolve một lần ở trên. Không lặp lại truy vấn
        // role/scope và không tải breakdown đầy đủ cho từng nhân sự trong batch.
        try {
          data[index] = await this.calculateEmployeeAuthorized(
            actorUserId,
            periodId,
            snapshot.employeeId,
            mode,
            true,
          );
        } catch (error) {
          if (
            mode === SalaryCalculationMode.PERSIST &&
            error instanceof AppException &&
            error.code === ErrorCode.SALARY_ALREADY_LOCKED
          ) {
            data[index] = { skippedLocked: true };
            return;
          }
          throw error;
        }
      },
    );
    const resolved = data.filter(
      (item): item is BatchItemResult => item !== undefined,
    );
    if (resolved.length !== calculableSnapshots.length) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'Không thể hoàn tất toàn bộ batch tính lương',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const completed = resolved.filter(
      (item): item is CalculationResult => !('skippedLocked' in item),
    );
    const skippedLockedCount =
      lockedEmployeeIds.size +
      resolved.filter((item) => 'skippedLocked' in item).length;
    const readyCount = completed.filter(
      (item) => item.status === SalaryRecordStatus.PENDING,
    ).length;
    if (mode === SalaryCalculationMode.PERSIST && readyCount > 0) {
      await this.auditLog.notify(this.prisma, [
        {
          actorUserId,
          action: 'SALARY_BATCH_CALCULATED',
          entityType: 'PayrollPeriod',
          entityId: periodId,
          payrollPeriodId: periodId,
          afterData: { status: SalaryRecordStatus.PENDING, count: readyCount },
        },
      ]);
    }
    return {
      mode,
      processedCount: completed.length,
      skippedLockedCount,
      warningCount: completed.filter((item) => item.status === 'WARNING')
        .length,
      data: completed,
    };
  }

  async list(
    actorUserId: string,
    periodId: number,
    query: ListSalaryRecordsQueryDto,
  ) {
    const scope = await this.authorization.resolveScope(actorUserId, 'salary');
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(actorUserId)
        : null;
    const departmentTeamIds = query.departmentId
      ? (
          await this.prisma.team.findMany({
            where: { departmentId: query.departmentId },
            select: { id: true },
          })
        ).map((team) => team.id)
      : null;
    const scopeWhere = this.periodScope.snapshotWhere(scope, selfEmployeeId);
    const filterWhere: Prisma.PayrollPeriodEmployeeSnapshotWhereInput = {
      AND: [
        query.departmentId
          ? { teamIdSnapshot: { in: departmentTeamIds ?? [] } }
          : {},
        query.teamId ? { teamIdSnapshot: query.teamId } : {},
      ],
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
              salaryRecords: {
                where: { payrollPeriodId: periodId },
                orderBy: { versionNumber: 'desc' },
                take: 1,
                include: salaryRecordSummaryInclude,
              },
            },
          },
        },
      }),
      this.prisma.payrollPeriodEmployeeSnapshot.count({ where }),
    ]);

    return paginate(
      snapshots.map((snapshot) => ({
        employeeId: snapshot.employeeId,
        employeeCode: snapshot.employeeCodeSnapshot,
        employeeName: snapshot.employeeNameSnapshot,
        jobTitle: snapshot.jobTitleSnapshot,
        teamId: snapshot.teamIdSnapshot,
        teamName: snapshot.teamNameSnapshot,
        salaryRecord: snapshot.employee.salaryRecords[0]
          ? this.serializeRecord(snapshot.employee.salaryRecords[0])
          : null,
      })),
      total,
      query.page,
      query.pageSize,
    );
  }

  async getOne(actorUserId: string, id: number) {
    const record = await this.prisma.salaryRecord.findUnique({
      where: { id },
      include: salaryRecordSummaryInclude,
    });
    if (!record) this.throwRecordNotFound();
    await this.assertVisible(
      actorUserId,
      record.payrollPeriodId,
      record.employeeId,
    );
    const snapshot = await this.getSnapshotOrThrow(
      record.payrollPeriodId,
      record.employeeId,
    );
    return {
      employeeCode: snapshot.employeeCodeSnapshot,
      employeeName: snapshot.employeeNameSnapshot,
      jobTitle: snapshot.jobTitleSnapshot,
      teamName: snapshot.teamNameSnapshot,
      ...this.serializeRecord(record),
    };
  }

  async getBreakdown(actorUserId: string, id: number) {
    const record = await this.prisma.salaryRecord.findUnique({
      where: { id },
      include: salaryRecordBreakdownInclude,
    });
    if (!record) this.throwRecordNotFound();
    await this.assertVisible(
      actorUserId,
      record.payrollPeriodId,
      record.employeeId,
    );
    const snapshot = await this.getSnapshotOrThrow(
      record.payrollPeriodId,
      record.employeeId,
    );
    const versionHistory = await this.prisma.salaryRecord.findMany({
      where: {
        payrollPeriodId: record.payrollPeriodId,
        employeeId: record.employeeId,
      },
      orderBy: { versionNumber: 'desc' },
      include: salaryRecordSummaryInclude,
    });
    const revenueBrackets = await this.prisma.revenueRewardBracket.findMany({
      where: { rewardRuleSetId: record.rewardRuleSetId },
      orderBy: { minRevenueAmount: 'asc' },
      select: {
        label: true,
        minRevenueAmount: true,
        maxRevenueAmount: true,
        commissionRatePercent: true,
        rpmRatePer1000Views: true,
      },
    });
    return {
      employeeCode: snapshot.employeeCodeSnapshot,
      employeeName: snapshot.employeeNameSnapshot,
      jobTitle: snapshot.jobTitleSnapshot,
      teamId: snapshot.teamIdSnapshot,
      teamName: snapshot.teamNameSnapshot,
      ...this.serializeBreakdown(record),
      revenueBrackets: revenueBrackets.map((bracket) => ({
        label: bracket.label,
        minRevenueAmount: bracket.minRevenueAmount.toFixed(0),
        maxRevenueAmount: bracket.maxRevenueAmount?.toFixed(0) ?? null,
        commissionRatePercent: bracket.commissionRatePercent.toString(),
        rpmRatePer1000Views: bracket.rpmRatePer1000Views.toString(),
      })),
      versionHistory: versionHistory.map((version) =>
        this.serializeVersionSummary(version),
      ),
    };
  }

  async approve(actorUserId: string, id: number) {
    const visibleRecord = await this.prisma.salaryRecord.findUnique({
      where: { id },
      select: { employeeId: true, payrollPeriodId: true },
    });
    if (!visibleRecord) this.throwRecordNotFound();
    await this.assertVisibleForPermission(
      actorUserId,
      visibleRecord.payrollPeriodId,
      visibleRecord.employeeId,
      'salary.final_approve',
    );

    return this.prisma.$transaction(async (tx) => {
      const record = await tx.salaryRecord.findUnique({
        where: { id },
        include: { payrollPeriod: { select: { status: true } } },
      });
      if (!record) this.throwRecordNotFound();

      if (
        record.status === SalaryRecordStatus.LOCKED ||
        record.status === SalaryRecordStatus.SUPERSEDED
      ) {
        throw new AppException(
          ErrorCode.SALARY_ALREADY_LOCKED,
          'Bản lương đã được duyệt và khóa trước đó',
          HttpStatus.CONFLICT,
        );
      }
      const warnings = this.readWarnings(record.calculationWarnings);
      if (
        record.status !== SalaryRecordStatus.PENDING ||
        warnings.length > 0 ||
        record.payrollPeriod.status === PayrollPeriodStatus.DRAFT ||
        record.payrollPeriod.status === PayrollPeriodStatus.CLOSED
      ) {
        throw new AppException(
          ErrorCode.SALARY_NOT_READY_FOR_APPROVAL,
          record.payrollPeriod.status === PayrollPeriodStatus.CLOSED
            ? 'Kỳ lương đã đóng nên không thể duyệt thêm bản lương'
            : 'Bản lương còn cảnh báo hoặc chưa sẵn sàng để duyệt',
          HttpStatus.BAD_REQUEST,
          { warningCount: warnings.length },
        );
      }

      const now = new Date();
      const claimed = await tx.salaryRecord.updateMany({
        where: { id, status: SalaryRecordStatus.PENDING },
        data: {
          status: SalaryRecordStatus.LOCKED,
          approvedByUserId: actorUserId,
          approvedAt: now,
          lockedAt: now,
        },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          ErrorCode.SALARY_ALREADY_LOCKED,
          'Bản lương vừa được xử lý bởi một yêu cầu khác',
          HttpStatus.CONFLICT,
        );
      }

      if (record.parentSalaryRecordId) {
        await tx.salaryRecord.updateMany({
          where: {
            id: record.parentSalaryRecordId,
            status: SalaryRecordStatus.LOCKED,
          },
          data: { status: SalaryRecordStatus.SUPERSEDED },
        });
      }

      const auditBase = {
        actorUserId,
        entityType: 'SalaryRecord',
        entityId: record.id,
        targetEmployeeId: record.employeeId,
        payrollPeriodId: record.payrollPeriodId,
      };
      await this.auditLog.recordMany(tx, [
        {
          ...auditBase,
          action: 'SALARY_APPROVED',
          beforeData: {
            status: record.status,
            approvedByUserId: record.approvedByUserId,
          },
          afterData: {
            status: SalaryRecordStatus.LOCKED,
            approvedByUserId: actorUserId,
            approvedAt: now.toISOString(),
            versionNumber: record.versionNumber,
            totalSalaryAmount: record.totalSalaryAmount.toFixed(0),
          },
        },
        {
          ...auditBase,
          action: 'SALARY_LOCKED',
          beforeData: { lockedAt: record.lockedAt },
          afterData: {
            status: SalaryRecordStatus.LOCKED,
            lockedAt: now.toISOString(),
            versionNumber: record.versionNumber,
            totalSalaryAmount: record.totalSalaryAmount.toFixed(0),
          },
        },
      ]);
      return {
        id: record.id,
        status: SalaryRecordStatus.LOCKED,
        versionNumber: record.versionNumber,
        approvedAt: now,
        lockedAt: now,
      };
    });
  }

  async createRevision(actorUserId: string, id: number) {
    const visibleRecord = await this.prisma.salaryRecord.findUnique({
      where: { id },
      select: { employeeId: true, payrollPeriodId: true },
    });
    if (!visibleRecord) this.throwRecordNotFound();
    await this.assertVisibleForPermission(
      actorUserId,
      visibleRecord.payrollPeriodId,
      visibleRecord.employeeId,
      'salary.create_revision',
    );

    // Bản đã LOCKED là snapshot bất biến, vì vậy tải dữ liệu cần sao chép trước khi mở
    // interactive transaction. Điều này tránh giữ transaction qua nhiều query include trên
    // database từ xa (nguyên nhân dễ làm Prisma hết hạn transaction mặc định sau 5 giây).
    const source = await this.prisma.salaryRecord.findUnique({
      where: { id },
      include: {
        payrollPeriod: { select: { status: true } },
        kpiItems: true,
        okrItems: true,
        components: true,
      },
    });
    if (!source) this.throwRecordNotFound();
    if (source.status !== SalaryRecordStatus.LOCKED) {
      throw new AppException(
        ErrorCode.SALARY_REVISION_REQUIRED,
        source.status === SalaryRecordStatus.SUPERSEDED
          ? 'Chỉ có thể tạo điều chỉnh từ phiên bản đã khóa mới nhất'
          : 'Chỉ có thể tạo phiên bản điều chỉnh từ bản lương đã khóa',
        HttpStatus.CONFLICT,
      );
    }
    if (
      source.payrollPeriod.status !== PayrollPeriodStatus.OPEN &&
      source.payrollPeriod.status !== PayrollPeriodStatus.IN_REVIEW
    ) {
      throw new AppException(
        ErrorCode.SALARY_REVISION_REQUIRED,
        'Chỉ có thể tạo bản điều chỉnh khi kỳ lương đang mở hoặc đang duyệt',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const latest = await tx.salaryRecord.findFirst({
            where: {
              employeeId: source.employeeId,
              payrollPeriodId: source.payrollPeriodId,
            },
            orderBy: { versionNumber: 'desc' },
            select: {
              id: true,
              versionNumber: true,
              status: true,
              payrollPeriod: { select: { status: true } },
            },
          });
          if (!latest || latest.id !== source.id) {
            throw new AppException(
              ErrorCode.SALARY_REVISION_REQUIRED,
              'Đã tồn tại phiên bản mới hơn của bản lương này',
              HttpStatus.CONFLICT,
            );
          }
          if (latest.status !== SalaryRecordStatus.LOCKED) {
            throw new AppException(
              ErrorCode.SALARY_REVISION_REQUIRED,
              'Phiên bản nguồn vừa thay đổi, vui lòng tải lại dữ liệu',
              HttpStatus.CONFLICT,
            );
          }
          if (
            latest.payrollPeriod.status !== PayrollPeriodStatus.OPEN &&
            latest.payrollPeriod.status !== PayrollPeriodStatus.IN_REVIEW
          ) {
            throw new AppException(
              ErrorCode.SALARY_REVISION_REQUIRED,
              'Kỳ lương vừa thay đổi trạng thái và không còn cho phép tạo điều chỉnh',
              HttpStatus.CONFLICT,
            );
          }

          const revision = await tx.salaryRecord.create({
            data: {
              employeeId: source.employeeId,
              payrollPeriodId: source.payrollPeriodId,
              versionNumber: source.versionNumber + 1,
              parentSalaryRecordId: source.id,
              rewardRuleSetId: source.rewardRuleSetId,
              revenueRewardBracketId: source.revenueRewardBracketId,
              baseSalaryAmount: source.baseSalaryAmount,
              kpiRewardAmount: source.kpiRewardAmount,
              okrRewardAmount: source.okrRewardAmount,
              revenueAmountSnapshot: source.revenueAmountSnapshot,
              commissionRatePercentSnapshot:
                source.commissionRatePercentSnapshot,
              commissionAmount: source.commissionAmount,
              totalViewsSnapshot: source.totalViewsSnapshot,
              rpmRatePer1000ViewsSnapshot: source.rpmRatePer1000ViewsSnapshot,
              rpmRewardAmount: source.rpmRewardAmount,
              additionalComponentAmount: source.additionalComponentAmount,
              totalSalaryAmount: source.totalSalaryAmount,
              status: SalaryRecordStatus.PENDING,
              calculationWarnings: this.readWarnings(
                source.calculationWarnings,
              ),
              calculatedByUserId: actorUserId,
              calculatedAt: new Date(),
              kpiItems:
                source.kpiItems.length > 0
                  ? {
                      createMany: {
                        data: source.kpiItems.map((item) => ({
                          kpiGroupId: item.kpiGroupId,
                          teamId: item.teamId,
                          teamNameSnapshot: item.teamNameSnapshot,
                          salaryWeightPercentSnapshot:
                            item.salaryWeightPercentSnapshot,
                          kpiGroupNameSnapshot: item.kpiGroupNameSnapshot,
                          progressPercent: item.progressPercent,
                          achievementThresholdPercentSnapshot:
                            item.achievementThresholdPercentSnapshot,
                          rewardAmountSnapshot: item.rewardAmountSnapshot,
                          isAchieved: item.isAchieved,
                          earnedAmount: item.earnedAmount,
                        })),
                      },
                    }
                  : undefined,
              okrItems:
                source.okrItems.length > 0
                  ? {
                      createMany: {
                        data: source.okrItems.map((item) => ({
                          employeeOkrId: item.employeeOkrId,
                          goalTypeSnapshot: item.goalTypeSnapshot,
                          okrTitleSnapshot: item.okrTitleSnapshot,
                          progressPercent: item.progressPercent,
                          achievementThresholdPercentSnapshot:
                            item.achievementThresholdPercentSnapshot,
                          rewardAmountSnapshot: item.rewardAmountSnapshot,
                          isAchieved: item.isAchieved,
                          earnedAmount: item.earnedAmount,
                        })),
                      },
                    }
                  : undefined,
              components:
                source.components.length > 0
                  ? {
                      createMany: {
                        data: source.components.map((component) => ({
                          componentCode: component.componentCode,
                          componentName: component.componentName,
                          amount: component.amount,
                          note: component.note,
                          source: component.source,
                          // Giữ người nhập gốc: bản điều chỉnh chỉ sao chép, không tạo khoản mới.
                          createdByUserId: component.createdByUserId,
                          createdAt: component.createdAt,
                        })),
                      },
                    }
                  : undefined,
            },
          });
          await this.auditLog.record(tx, {
            actorUserId,
            action: 'SALARY_REVISION_CREATED',
            entityType: 'SalaryRecord',
            entityId: revision.id,
            targetEmployeeId: source.employeeId,
            payrollPeriodId: source.payrollPeriodId,
            beforeData: {
              sourceSalaryRecordId: source.id,
              versionNumber: source.versionNumber,
              status: source.status,
              totalSalaryAmount: source.totalSalaryAmount.toFixed(0),
            },
            afterData: {
              parentSalaryRecordId: source.id,
              versionNumber: revision.versionNumber,
              status: revision.status,
              totalSalaryAmount: revision.totalSalaryAmount.toFixed(0),
            },
          });
          return {
            id: revision.id,
            status: revision.status,
            versionNumber: revision.versionNumber,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: SALARY_TRANSACTION_MAX_WAIT_MS,
          timeout: SALARY_TRANSACTION_TIMEOUT_MS,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' ||
          error.code === 'P2028' ||
          error.code === 'P2034')
      ) {
        throw new AppException(
          ErrorCode.CONFLICT,
          error.code === 'P2028'
            ? 'Phiên tạo bản điều chỉnh đã hết hạn, vui lòng thử lại'
            : 'Đã có yêu cầu tạo phiên bản điều chỉnh khác được xử lý',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async addBonus(actorUserId: string, id: number, dto: CreateSalaryBonusDto) {
    const record = await this.getBonusEditableRecord(actorUserId, id);
    const amount = new Prisma.Decimal(dto.amount);
    const note = dto.note || null;
    return this.runBonusTransaction(async (tx) => {
      // Cộng thẳng vào snapshot thay vì tính lại cả bảng lương: các khoản khác không đổi, và
      // điều kiện trạng thái trong updateMany chặn việc cộng vào bản vừa được duyệt đồng thời.
      await this.claimBonusEditableRecord(tx, id, {
        additionalComponentAmount: { increment: amount },
        totalSalaryAmount: { increment: amount },
      });
      const [bonus, updated] = await Promise.all([
        tx.salaryRecordComponent.create({
          data: {
            salaryRecordId: id,
            componentCode: SALARY_BONUS_COMPONENT_CODE,
            componentName: dto.name,
            amount,
            note,
            source: SalaryComponentSource.MANUAL,
            createdByUserId: actorUserId,
          },
          select: { id: true },
        }),
        tx.salaryRecord.findUniqueOrThrow({
          where: { id },
          select: { totalSalaryAmount: true },
        }),
      ]);
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'SALARY_BONUS_ADDED',
        entityType: 'SalaryRecord',
        entityId: id,
        targetEmployeeId: record.employeeId,
        payrollPeriodId: record.payrollPeriodId,
        beforeData: {
          totalSalaryAmount: updated.totalSalaryAmount.minus(amount).toFixed(0),
        },
        afterData: {
          bonusName: dto.name,
          bonusAmount: amount.toFixed(0),
          ...(note ? { note } : {}),
          totalSalaryAmount: updated.totalSalaryAmount.toFixed(0),
        },
      });
      return {
        id: bonus.id,
        salaryRecordId: id,
        totalSalaryAmount: updated.totalSalaryAmount.toFixed(0),
      };
    });
  }

  async removeBonus(actorUserId: string, id: number, bonusId: number) {
    const [record, bonus] = await Promise.all([
      this.getBonusEditableRecord(actorUserId, id),
      this.prisma.salaryRecordComponent.findFirst({
        where: { id: bonusId, salaryRecordId: id },
        select: { componentName: true, amount: true, source: true },
      }),
    ]);
    if (!bonus) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy khoản thưởng thêm',
        HttpStatus.NOT_FOUND,
      );
    }
    if (bonus.source !== SalaryComponentSource.MANUAL) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Chỉ xóa được khoản thưởng nhập tay',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.runBonusTransaction(async (tx) => {
      // Xóa trước rồi mới trừ tiền: hai request xóa cùng lúc chỉ một bên xóa được, nên tổng lương
      // không bị trừ hai lần.
      const deleted = await tx.salaryRecordComponent.deleteMany({
        where: { id: bonusId, salaryRecordId: id },
      });
      if (deleted.count !== 1) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Khoản thưởng vừa được xóa bởi một yêu cầu khác',
          HttpStatus.CONFLICT,
        );
      }
      await this.claimBonusEditableRecord(tx, id, {
        additionalComponentAmount: { decrement: bonus.amount },
        totalSalaryAmount: { decrement: bonus.amount },
      });
      const updated = await tx.salaryRecord.findUniqueOrThrow({
        where: { id },
        select: { totalSalaryAmount: true },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'SALARY_BONUS_REMOVED',
        entityType: 'SalaryRecord',
        entityId: id,
        targetEmployeeId: record.employeeId,
        payrollPeriodId: record.payrollPeriodId,
        beforeData: {
          bonusName: bonus.componentName,
          bonusAmount: bonus.amount.toFixed(0),
          totalSalaryAmount: updated.totalSalaryAmount
            .plus(bonus.amount)
            .toFixed(0),
        },
        afterData: {
          totalSalaryAmount: updated.totalSalaryAmount.toFixed(0),
        },
      });
      return {
        id: bonusId,
        salaryRecordId: id,
        totalSalaryAmount: updated.totalSalaryAmount.toFixed(0),
      };
    });
  }

  private async getBonusEditableRecord(actorUserId: string, id: number) {
    const record = await this.prisma.salaryRecord.findUnique({
      where: { id },
      select: {
        employeeId: true,
        payrollPeriodId: true,
        status: true,
        payrollPeriod: { select: { status: true } },
      },
    });
    if (!record) this.throwRecordNotFound();
    await this.assertVisibleForPermission(
      actorUserId,
      record.payrollPeriodId,
      record.employeeId,
      'salary.bonus',
    );
    if (!BONUS_EDITABLE_STATUSES.some((status) => status === record.status)) {
      throw new AppException(
        ErrorCode.SALARY_ALREADY_LOCKED,
        'Bản lương đã khóa; cần tạo phiên bản điều chỉnh trước khi thay đổi thưởng thêm',
        HttpStatus.CONFLICT,
      );
    }
    if (
      record.payrollPeriod.status !== PayrollPeriodStatus.OPEN &&
      record.payrollPeriod.status !== PayrollPeriodStatus.IN_REVIEW
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Chỉ thay đổi thưởng thêm khi kỳ lương đang mở hoặc đang duyệt',
        HttpStatus.BAD_REQUEST,
      );
    }
    return record;
  }

  private async claimBonusEditableRecord(
    tx: Prisma.TransactionClient,
    id: number,
    data: Prisma.SalaryRecordUpdateManyMutationInput,
  ) {
    const claimed = await tx.salaryRecord.updateMany({
      where: { id, status: { in: BONUS_EDITABLE_STATUSES } },
      data,
    });
    if (claimed.count !== 1) {
      throw new AppException(
        ErrorCode.SALARY_ALREADY_LOCKED,
        'Bản lương vừa được duyệt hoặc thay đổi bởi một yêu cầu khác',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async runBonusTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    try {
      return await this.prisma.$transaction(operation, {
        maxWait: SALARY_TRANSACTION_MAX_WAIT_MS,
        timeout: SALARY_TRANSACTION_TIMEOUT_MS,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2028' || error.code === 'P2034')
      ) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Bản lương vừa thay đổi, vui lòng tải lại và thực hiện lại',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  private async buildCalculation(
    periodId: number,
    employeeId: number,
    db: DbClient,
  ): Promise<SalaryCalculation> {
    const period = await this.getCalculablePeriod(periodId, db);
    const snapshot = await this.getSnapshotOrThrow(periodId, employeeId, db);
    const effectiveAt = period.endDate;
    const [
      baseSalary,
      assignments,
      rewardRates,
      okrs,
      trafficRecords,
      revenueRecord,
      conflictItems,
      currentSalaryRecord,
    ] = await Promise.all([
      db.baseSalaryHistory.findFirst({
        where: {
          employeeId,
          effectiveFrom: { lte: effectiveAt },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveAt } }],
        },
        orderBy: { effectiveFrom: 'desc' },
        select: { monthlyBaseSalary: true },
      }),
      db.employeeKpiAssignment.findMany({
        where: {
          employeeId,
          payrollPeriodId: periodId,
          assignmentStatus: 'ASSIGNED',
        },
        select: {
          teamId: true,
          team: { select: { name: true } },
          kpiGroup: {
            select: {
              id: true,
              name: true,
              items: {
                where: { isActive: true },
                orderBy: { sortOrder: 'asc' },
                select: {
                  id: true,
                  name: true,
                  direction: true,
                  externalItemId: true,
                  periodTargets: {
                    where: { payrollPeriodId: periodId },
                    select: { targetValue: true },
                  },
                  employeeTargets: {
                    where: { employeeId, payrollPeriodId: periodId },
                    select: {
                      teamId: true,
                      targetValue: true,
                      overrideValue: true,
                    },
                  },
                  employeeActuals: {
                    where: { employeeId, payrollPeriodId: periodId },
                    select: {
                      teamId: true,
                      actualValue: true,
                      overrideValue: true,
                      requiresManualEntry: true,
                      manualEnteredAt: true,
                      leaderReviewStatus: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      db.employeeKpiRewardRate.findMany({
        where: {
          employeeId,
          effectiveFrom: { lte: effectiveAt },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveAt } }],
        },
        orderBy: { effectiveFrom: 'desc' },
        select: { kpiGroupId: true, rewardAmount: true },
      }),
      db.employeeOkr.findMany({
        where: {
          employeeId,
          payrollPeriodId: periodId,
          goalType: 'OKR',
          isActive: true,
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          goalType: true,
          title: true,
          targetValue: true,
          actualValue: true,
          overrideValue: true,
          direction: true,
          actualMissing: true,
          rewardAmount: true,
          selfConfirmationStatus: true,
          leaderReviewStatus: true,
        },
      }),
      db.employeeTrafficRecord.findMany({
        where: { employeeId, payrollPeriodId: periodId },
        select: {
          views: true,
          selfConfirmationStatus: true,
          leaderReviewStatus: true,
        },
      }),
      db.employeeRevenueRecord.findUnique({
        where: {
          employeeId_payrollPeriodId: { employeeId, payrollPeriodId: periodId },
        },
        select: { officialRevenueAmount: true },
      }),
      db.kpiSyncRunItem.findMany({
        where: {
          employeeId,
          resultStatus: 'CONFLICT',
          run: { payrollPeriodId: periodId },
        },
        orderBy: { id: 'desc' },
        select: {
          employeeKpiActualId: true,
          externalRecordKey: true,
          incomingValue: true,
          employeeKpiActual: {
            select: { actualValue: true, overrideValue: true },
          },
        },
      }),
      db.salaryRecord.findFirst({
        where: { employeeId, payrollPeriodId: periodId },
        orderBy: { versionNumber: 'desc' },
        select: { components: { select: { amount: true } } },
      }),
    ]);

    const warnings: SalaryWarning[] = [];
    if (!baseSalary) {
      warnings.push({
        code: 'BASE_SALARY_MISSING',
        message: 'Chưa có mức lương cơ bản hiệu lực tại ngày kết thúc kỳ.',
      });
    }
    if (!revenueRecord) {
      warnings.push({
        code: 'REVENUE_MISSING',
        message: 'Chưa có doanh thu chính thức.',
      });
    }
    const latestConflictByActual = new Map<
      string,
      (typeof conflictItems)[number]
    >();
    for (const conflict of conflictItems) {
      const key = conflict.employeeKpiActualId
        ? `actual:${conflict.employeeKpiActualId}`
        : `external:${conflict.externalRecordKey}`;
      if (!latestConflictByActual.has(key))
        latestConflictByActual.set(key, conflict);
    }
    const unresolvedConflicts = [...latestConflictByActual.values()].filter(
      (conflict) => {
        const current =
          conflict.employeeKpiActual?.overrideValue ??
          conflict.employeeKpiActual?.actualValue;
        return (
          !current ||
          !conflict.incomingValue ||
          !current.equals(conflict.incomingValue)
        );
      },
    );
    if (unresolvedConflicts.length > 0) {
      warnings.push({
        code: 'KPI_SYNC_CONFLICT',
        message: 'Còn xung đột đồng bộ KPI cần đối soát.',
        context: { count: unresolvedConflicts.length },
      });
    }

    const threshold = period.rewardRuleSet!.achievementThresholdPercent;
    const rateByGroup = new Map<number, (typeof rewardRates)[number]>();
    for (const rate of rewardRates) {
      if (!rateByGroup.has(rate.kpiGroupId))
        rateByGroup.set(rate.kpiGroupId, rate);
    }
    const teamSnapshots = snapshot.teamSnapshots ?? [
      {
        teamId: snapshot.teamIdSnapshot,
        teamNameSnapshot: snapshot.teamNameSnapshot,
        salaryWeightPercent: new Prisma.Decimal(100),
      },
    ];
    const kpiItems: CalculatedKpiItem[] = assignments.map((assignment) => {
      const group = assignment.kpiGroup;
      const assignmentTeamId = assignment.teamId ?? snapshot.teamIdSnapshot;
      const assignmentTeamName =
        assignment.team?.name ?? snapshot.teamNameSnapshot;
      const teamSnapshot = teamSnapshots.find(
        (team) => team.teamId === assignmentTeamId,
      );
      const salaryWeightPercent =
        teamSnapshot?.salaryWeightPercent ?? new Prisma.Decimal(0);
      if (!teamSnapshot) {
        warnings.push({
          code: 'KPI_TEAM_SNAPSHOT_MISSING',
          message: `Không tìm thấy snapshot team “${assignmentTeamName}” cho KPI.`,
          context: { teamId: assignmentTeamId, kpiGroupId: group.id },
        });
      }
      const progressInputs: Array<{
        actual: Prisma.Decimal;
        target: Prisma.Decimal;
        direction?: 'AT_LEAST' | 'AT_MOST';
      }> = [];
      const applicableItems = group.items.filter(
        (item) =>
          item.externalItemId == null ||
          item.employeeTargets.some(
            (target) => target.teamId === assignmentTeamId,
          ),
      );
      if (applicableItems.length === 0) {
        warnings.push({
          code: 'KPI_ITEMS_MISSING',
          message: `Nhóm KPI “${group.name}” không có đầu mục đang hoạt động.`,
          context: { kpiGroupId: group.id },
        });
      }
      for (const item of applicableItems) {
        const employeeTarget = item.employeeTargets.find(
          (target) =>
            target.teamId == null || target.teamId === assignmentTeamId,
        );
        const target =
          employeeTarget?.overrideValue ??
          employeeTarget?.targetValue ??
          item.periodTargets[0]?.targetValue;
        if (!target || target.lte(0)) {
          warnings.push({
            code: 'KPI_TARGET_MISSING',
            message: `Đầu mục KPI “${item.name}” chưa có mục tiêu hợp lệ.`,
            context: { kpiGroupId: group.id, kpiItemId: item.id },
          });
          continue;
        }
        const actual = item.employeeActuals.find(
          (candidate) =>
            candidate.teamId == null || candidate.teamId === assignmentTeamId,
        );
        if (
          !actual ||
          (actual.requiresManualEntry && actual.manualEnteredAt == null)
        ) {
          warnings.push({
            code: 'KPI_ACTUAL_MISSING',
            message: `Đầu mục KPI “${item.name}” chưa có dữ liệu thực tế.`,
            context: { kpiGroupId: group.id, kpiItemId: item.id },
          });
          progressInputs.push({
            actual: ZERO,
            target,
          });
          continue;
        }
        if (actual.leaderReviewStatus !== 'APPROVED') {
          warnings.push({
            code: 'KPI_NOT_APPROVED',
            message: `Đầu mục KPI “${item.name}” chưa được Leader duyệt.`,
            context: { kpiGroupId: group.id, kpiItemId: item.id },
          });
        }
        progressInputs.push({
          actual: actual.overrideValue ?? actual.actualValue,
          target,
          direction: item.direction,
        });
      }
      const progressPercent = calculateProgressPercent(progressInputs);
      const rate = rateByGroup.get(group.id);
      if (!rate) {
        warnings.push({
          code: 'KPI_REWARD_RATE_MISSING',
          message: `Chưa cấu hình mức tiền KPI cho nhóm “${group.name}”.`,
          context: { kpiGroupId: group.id },
        });
      }
      const rewardAmount = rate?.rewardAmount ?? ZERO;
      const rawEarnedAmount = calculateBinaryReward(
        progressPercent,
        threshold,
        rewardAmount,
      );
      const earnedAmount = roundMoney(
        rawEarnedAmount.mul(salaryWeightPercent).div(100),
      );
      return {
        teamId: assignmentTeamId,
        teamName: teamSnapshot?.teamNameSnapshot ?? assignmentTeamName,
        salaryWeightPercent,
        kpiGroupId: group.id,
        kpiGroupName: group.name,
        progressPercent,
        thresholdPercent: threshold,
        rewardAmount,
        earnedAmount,
        isAchieved: progressPercent.gte(threshold),
      };
    });

    const okrItems: CalculatedOkrItem[] = okrs.map((okr) => {
      const goalType = okr.goalType ?? 'OKR';
      if (okr.actualMissing) {
        warnings.push({
          code: 'PERFORMANCE_GOAL_ACTUAL_MISSING',
          message: `${goalType} “${okr.title}” chưa có số thực đạt từ VCBI.`,
          context: { employeeOkrId: okr.id },
        });
      }
      if (
        okr.selfConfirmationStatus !== 'CONFIRMED' ||
        okr.leaderReviewStatus !== 'APPROVED'
      ) {
        warnings.push({
          code: 'OKR_NOT_APPROVED',
          message: `${goalType} “${okr.title}” chưa hoàn tất xác nhận và duyệt.`,
          context: { employeeOkrId: okr.id },
        });
      }
      const progressPercent = okr.actualMissing
        ? ZERO
        : calculatePerformanceGoalProgressPercent(
            okr.overrideValue ?? okr.actualValue,
            okr.targetValue,
            okr.direction,
          );
      const earnedAmount = calculateBinaryReward(
        progressPercent,
        threshold,
        okr.rewardAmount,
      );
      return {
        employeeOkrId: okr.id,
        goalType,
        title: okr.title,
        progressPercent,
        thresholdPercent: threshold,
        rewardAmount: okr.rewardAmount,
        earnedAmount,
        isAchieved: progressPercent.gte(threshold),
      };
    });

    const acceptedTraffic = trafficRecords.filter(
      (record) =>
        record.selfConfirmationStatus === 'CONFIRMED' &&
        record.leaderReviewStatus === 'APPROVED',
    );
    if (trafficRecords.length === 0) {
      warnings.push({
        code: 'TRAFFIC_MISSING',
        message: 'Chưa có dữ liệu traffic trong kỳ.',
      });
    } else if (acceptedTraffic.length !== trafficRecords.length) {
      warnings.push({
        code: 'TRAFFIC_PENDING',
        message: 'Có dữ liệu traffic chưa hoàn tất xác nhận hoặc duyệt.',
        context: {
          total: trafficRecords.length,
          accepted: acceptedTraffic.length,
        },
      });
    }
    const totalViews = acceptedTraffic.reduce(
      (total, record) => total + record.views,
      0n,
    );
    const revenueAmount = revenueRecord?.officialRevenueAmount ?? ZERO;
    const matchedBrackets = revenueRecord
      ? resolveRevenueBracket(
          revenueAmount,
          period.rewardRuleSet!.revenueBrackets,
        )
      : [];
    if (revenueRecord && matchedBrackets.length === 0) {
      warnings.push({
        code: 'REVENUE_BRACKET_MISSING',
        message: 'Doanh thu không khớp mốc thưởng nào trong ruleset của kỳ.',
      });
    } else if (matchedBrackets.length > 1) {
      warnings.push({
        code: 'REVENUE_BRACKET_AMBIGUOUS',
        message: 'Doanh thu đang khớp nhiều hơn một mốc thưởng.',
        context: { count: matchedBrackets.length },
      });
    }
    const bracket = matchedBrackets[0] ?? null;
    const commissionRate = bracket?.commissionRatePercent ?? ZERO;
    const rpmRate = bracket?.rpmRatePer1000Views ?? ZERO;
    const commissionAmount = calculateCommission(revenueAmount, commissionRate);
    const rpmRewardAmount = calculateRpm(totalViews, rpmRate);
    const kpiRewardAmount = kpiItems
      .reduce((sum, item) => sum.plus(item.earnedAmount), ZERO)
      .plus(
        okrItems
          .filter((item) => item.goalType === 'KPI')
          .reduce((sum, item) => sum.plus(item.earnedAmount), ZERO),
      );
    const okrRewardAmount = okrItems.reduce(
      (sum, item) =>
        item.goalType === 'OKR' ? sum.plus(item.earnedAmount) : sum,
      ZERO,
    );
    const additionalComponentAmount =
      currentSalaryRecord?.components.reduce(
        (sum, component) => sum.plus(component.amount),
        ZERO,
      ) ?? ZERO;
    const baseSalaryAmount = baseSalary?.monthlyBaseSalary ?? ZERO;
    const totalSalaryAmount = baseSalaryAmount
      .plus(kpiRewardAmount)
      .plus(okrRewardAmount)
      .plus(commissionAmount)
      .plus(rpmRewardAmount)
      .plus(additionalComponentAmount);

    return {
      employeeId,
      payrollPeriodId: periodId,
      employeeCode: snapshot.employeeCodeSnapshot,
      employeeName: snapshot.employeeNameSnapshot,
      jobTitle: snapshot.jobTitleSnapshot,
      teamId: snapshot.teamIdSnapshot,
      teamName: snapshot.teamNameSnapshot,
      rewardRuleSetId: period.rewardRuleSet!.id,
      rewardRuleSetVersion: period.rewardRuleSet!.version,
      revenueRewardBracketId: bracket?.id ?? null,
      revenueRewardBracketLabel: bracket?.label ?? null,
      baseSalaryAmount,
      kpiRewardAmount,
      okrRewardAmount,
      revenueAmount,
      commissionRatePercent: commissionRate,
      commissionAmount,
      totalViews,
      rpmRatePer1000Views: rpmRate,
      rpmRewardAmount,
      additionalComponentAmount,
      totalSalaryAmount,
      status:
        warnings.length > 0
          ? SalaryRecordStatus.WARNING
          : SalaryRecordStatus.PENDING,
      warnings,
      kpiItems,
      okrItems,
    };
  }

  private async persistCalculation(
    actorUserId: string,
    calculation: SalaryCalculation,
    tx: Prisma.TransactionClient,
    suppressNotification = false,
  ) {
    const existing = await tx.salaryRecord.findFirst({
      where: {
        employeeId: calculation.employeeId,
        payrollPeriodId: calculation.payrollPeriodId,
      },
      orderBy: { versionNumber: 'desc' },
    });
    if (
      existing?.status === SalaryRecordStatus.LOCKED ||
      existing?.status === SalaryRecordStatus.SUPERSEDED
    ) {
      throw new AppException(
        ErrorCode.SALARY_ALREADY_LOCKED,
        'Bản lương hiện tại đã khóa; cần tạo revision theo quy trình M14',
        HttpStatus.BAD_REQUEST,
      );
    }

    const financialData = {
      rewardRuleSetId: calculation.rewardRuleSetId,
      revenueRewardBracketId: calculation.revenueRewardBracketId,
      baseSalaryAmount: calculation.baseSalaryAmount,
      kpiRewardAmount: calculation.kpiRewardAmount,
      okrRewardAmount: calculation.okrRewardAmount,
      revenueAmountSnapshot: calculation.revenueAmount,
      commissionRatePercentSnapshot: calculation.commissionRatePercent,
      commissionAmount: calculation.commissionAmount,
      totalViewsSnapshot: calculation.totalViews,
      rpmRatePer1000ViewsSnapshot: calculation.rpmRatePer1000Views,
      rpmRewardAmount: calculation.rpmRewardAmount,
      additionalComponentAmount: calculation.additionalComponentAmount,
      totalSalaryAmount: calculation.totalSalaryAmount,
      status: calculation.status,
      calculationWarnings: calculation.warnings as Prisma.InputJsonValue,
      calculatedByUserId: actorUserId,
      calculatedAt: new Date(),
    };
    let recordId: number;
    let versionNumber: number;
    if (existing) {
      const claimed = await tx.salaryRecord.updateMany({
        where: {
          id: existing.id,
          status: {
            in: [SalaryRecordStatus.PENDING, SalaryRecordStatus.WARNING],
          },
        },
        data: financialData,
      });
      if (claimed.count !== 1) {
        throw new AppException(
          ErrorCode.SALARY_ALREADY_LOCKED,
          'Bản lương vừa được duyệt hoặc thay đổi bởi một yêu cầu khác',
          HttpStatus.CONFLICT,
        );
      }
      await Promise.all([
        tx.salaryRecordKpiItem.deleteMany({
          where: { salaryRecordId: existing.id },
        }),
        tx.salaryRecordOkrItem.deleteMany({
          where: { salaryRecordId: existing.id },
        }),
      ]);
      recordId = existing.id;
      versionNumber = existing.versionNumber;
    } else {
      const created = await tx.salaryRecord.create({
        data: {
          employeeId: calculation.employeeId,
          payrollPeriodId: calculation.payrollPeriodId,
          versionNumber: 1,
          ...financialData,
        },
      });
      recordId = created.id;
      versionNumber = created.versionNumber;
    }

    if (calculation.kpiItems.length > 0) {
      await tx.salaryRecordKpiItem.createMany({
        data: calculation.kpiItems.map((item) => ({
          salaryRecordId: recordId,
          kpiGroupId: item.kpiGroupId,
          teamId: item.teamId,
          teamNameSnapshot: item.teamName,
          salaryWeightPercentSnapshot: item.salaryWeightPercent,
          kpiGroupNameSnapshot: item.kpiGroupName,
          progressPercent: item.progressPercent,
          achievementThresholdPercentSnapshot: item.thresholdPercent,
          rewardAmountSnapshot: item.rewardAmount,
          isAchieved: item.isAchieved,
          earnedAmount: item.earnedAmount,
        })),
      });
    }
    if (calculation.okrItems.length > 0) {
      await tx.salaryRecordOkrItem.createMany({
        data: calculation.okrItems.map((item) => ({
          salaryRecordId: recordId,
          employeeOkrId: item.employeeOkrId,
          goalTypeSnapshot: item.goalType,
          okrTitleSnapshot: item.title,
          progressPercent: item.progressPercent,
          achievementThresholdPercentSnapshot: item.thresholdPercent,
          rewardAmountSnapshot: item.rewardAmount,
          isAchieved: item.isAchieved,
          earnedAmount: item.earnedAmount,
        })),
      });
    }
    await this.auditLog.record(tx, {
      actorUserId,
      action: existing ? 'SALARY_RECALCULATED' : 'SALARY_CALCULATED',
      entityType: 'SalaryRecord',
      entityId: recordId,
      targetEmployeeId: calculation.employeeId,
      payrollPeriodId: calculation.payrollPeriodId,
      beforeData: existing
        ? {
            totalSalaryAmount: existing.totalSalaryAmount.toFixed(0),
            status: existing.status,
          }
        : undefined,
      afterData: {
        versionNumber,
        totalSalaryAmount: calculation.totalSalaryAmount.toFixed(0),
        status: calculation.status,
        warningCount: calculation.warnings.length,
      },
      suppressNotification,
    });
    return recordId;
  }

  private async getCalculablePeriod(
    periodId: number,
    db: DbClient = this.prisma,
  ) {
    const period = await db.payrollPeriod.findUnique({
      where: { id: periodId },
      select: {
        status: true,
        endDate: true,
        rewardRuleSet: {
          select: {
            id: true,
            version: true,
            achievementThresholdPercent: true,
            revenueBrackets: {
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                label: true,
                minRevenueAmount: true,
                maxRevenueAmount: true,
                commissionRatePercent: true,
                rpmRatePer1000Views: true,
              },
            },
          },
        },
      },
    });
    if (!period) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy kỳ lương',
        HttpStatus.NOT_FOUND,
      );
    }
    if (
      period.status !== PayrollPeriodStatus.OPEN &&
      period.status !== PayrollPeriodStatus.IN_REVIEW
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Chỉ có thể tính lương khi kỳ đang OPEN hoặc IN_REVIEW',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!period.rewardRuleSet) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Kỳ lương chưa được gắn Reward Rule Set',
        HttpStatus.BAD_REQUEST,
      );
    }
    return period;
  }

  private async assertPeriodExists(periodId: number) {
    const count = await this.prisma.payrollPeriod.count({
      where: { id: periodId },
    });
    if (count === 0) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy kỳ lương',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async getSnapshotOrThrow(
    periodId: number,
    employeeId: number,
    db: DbClient = this.prisma,
  ) {
    const snapshot = await db.payrollPeriodEmployeeSnapshot.findUnique({
      where: {
        payrollPeriodId_employeeId: { payrollPeriodId: periodId, employeeId },
      },
      select: {
        employeeId: true,
        employeeCodeSnapshot: true,
        employeeNameSnapshot: true,
        jobTitleSnapshot: true,
        teamIdSnapshot: true,
        teamNameSnapshot: true,
        teamSnapshots: {
          select: {
            teamId: true,
            teamNameSnapshot: true,
            salaryWeightPercent: true,
            isPrimary: true,
          },
        },
      },
    });
    if (!snapshot) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự không thuộc snapshot của kỳ lương này',
        HttpStatus.BAD_REQUEST,
      );
    }
    return snapshot;
  }

  private async assertVisible(
    actorUserId: string,
    periodId: number,
    employeeId: number,
  ) {
    const scope = await this.authorization.resolveScope(actorUserId, 'salary');
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(actorUserId)
        : null;
    const visible = await this.periodScope.includesEmployee(
      scope,
      periodId,
      employeeId,
      selfEmployeeId,
    );
    if (!visible) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Bản lương này nằm ngoài phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertVisibleForPermission(
    actorUserId: string,
    periodId: number,
    employeeId: number,
    permissionCode:
      | 'salary.calculate'
      | 'salary.final_approve'
      | 'salary.create_revision'
      | 'salary.bonus',
  ) {
    const scope = await this.authorization.resolvePermissionScope(
      actorUserId,
      permissionCode,
    );
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(actorUserId)
        : null;
    const visible = await this.periodScope.includesEmployee(
      scope,
      periodId,
      employeeId,
      selfEmployeeId,
    );
    if (!visible) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Bản lương này nằm ngoài phạm vi thao tác của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private throwRecordNotFound(): never {
    throw new AppException(
      ErrorCode.NOT_FOUND,
      'Không tìm thấy bản lương',
      HttpStatus.NOT_FOUND,
    );
  }

  private serializeCalculation(
    calculation: SalaryCalculation,
    id: number | null,
  ) {
    return {
      id,
      mode: SalaryCalculationMode.PREVIEW,
      employeeId: calculation.employeeId,
      payrollPeriodId: calculation.payrollPeriodId,
      employeeCode: calculation.employeeCode,
      employeeName: calculation.employeeName,
      jobTitle: calculation.jobTitle,
      teamId: calculation.teamId,
      teamName: calculation.teamName,
      rewardRuleSetId: calculation.rewardRuleSetId,
      rewardRuleSetVersion: calculation.rewardRuleSetVersion,
      revenueRewardBracketId: calculation.revenueRewardBracketId,
      revenueRewardBracketLabel: calculation.revenueRewardBracketLabel,
      baseSalaryAmount: calculation.baseSalaryAmount.toFixed(0),
      kpiRewardAmount: calculation.kpiRewardAmount.toFixed(0),
      okrRewardAmount: calculation.okrRewardAmount.toFixed(0),
      revenueAmount: calculation.revenueAmount.toFixed(0),
      commissionRatePercent: calculation.commissionRatePercent.toString(),
      commissionAmount: calculation.commissionAmount.toFixed(0),
      totalViews: calculation.totalViews.toString(),
      rpmRatePer1000Views: calculation.rpmRatePer1000Views.toString(),
      rpmRewardAmount: calculation.rpmRewardAmount.toFixed(0),
      additionalComponentAmount:
        calculation.additionalComponentAmount.toFixed(0),
      totalSalaryAmount: calculation.totalSalaryAmount.toFixed(0),
      status: calculation.status,
      warnings: calculation.warnings,
      kpiItems: calculation.kpiItems.map((item) => ({
        ...item,
        salaryWeightPercent: item.salaryWeightPercent.toString(),
        progressPercent: item.progressPercent.toString(),
        thresholdPercent: item.thresholdPercent.toString(),
        rewardAmount: item.rewardAmount.toFixed(0),
        earnedAmount: item.earnedAmount.toFixed(0),
      })),
      okrItems: calculation.okrItems.map((item) => ({
        ...item,
        progressPercent: item.progressPercent.toString(),
        thresholdPercent: item.thresholdPercent.toString(),
        rewardAmount: item.rewardAmount.toFixed(0),
        earnedAmount: item.earnedAmount.toFixed(0),
      })),
    };
  }

  private serializeRecord(record: SalaryRecordSummary) {
    return {
      id: record.id,
      employeeId: record.employeeId,
      payrollPeriodId: record.payrollPeriodId,
      versionNumber: record.versionNumber,
      parentSalaryRecordId: record.parentSalaryRecordId,
      rewardRuleSetId: record.rewardRuleSetId,
      rewardRuleSetVersion: record.rewardRuleSet.version,
      revenueRewardBracketId: record.revenueRewardBracketId,
      revenueRewardBracketLabel: record.revenueRewardBracket?.label ?? null,
      baseSalaryAmount: record.baseSalaryAmount.toFixed(0),
      kpiRewardAmount: record.kpiRewardAmount.toFixed(0),
      okrRewardAmount: record.okrRewardAmount.toFixed(0),
      revenueAmount: record.revenueAmountSnapshot.toFixed(0),
      commissionRatePercent: record.commissionRatePercentSnapshot.toString(),
      commissionAmount: record.commissionAmount.toFixed(0),
      totalViews: record.totalViewsSnapshot.toString(),
      rpmRatePer1000Views: record.rpmRatePer1000ViewsSnapshot.toString(),
      rpmRewardAmount: record.rpmRewardAmount.toFixed(0),
      additionalComponentAmount: record.additionalComponentAmount.toFixed(0),
      totalSalaryAmount: record.totalSalaryAmount.toFixed(0),
      status: record.status,
      warnings: this.readWarnings(record.calculationWarnings),
      calculatedAt: record.calculatedAt,
      approvedAt: record.approvedAt,
      lockedAt: record.lockedAt,
      calculatedBy: record.calculatedBy,
      approvedBy: record.approvedBy,
    };
  }

  private serializeVersionSummary(record: SalaryRecordSummary) {
    return {
      id: record.id,
      versionNumber: record.versionNumber,
      parentSalaryRecordId: record.parentSalaryRecordId,
      status: record.status,
      totalSalaryAmount: record.totalSalaryAmount.toFixed(0),
      calculatedAt: record.calculatedAt,
      lockedAt: record.lockedAt,
      calculatedBy: record.calculatedBy,
      approvedBy: record.approvedBy,
    };
  }

  private serializeBreakdown(record: SalaryRecordBreakdown) {
    return {
      ...this.serializeRecord(record),
      kpiItems: record.kpiItems.map((item) => ({
        id: item.id,
        kpiGroupId: item.kpiGroupId,
        teamId: item.teamId,
        teamName: item.teamNameSnapshot,
        salaryWeightPercent: item.salaryWeightPercentSnapshot.toString(),
        kpiGroupName: item.kpiGroupNameSnapshot,
        progressPercent: item.progressPercent.toString(),
        thresholdPercent: item.achievementThresholdPercentSnapshot.toString(),
        rewardAmount: item.rewardAmountSnapshot.toFixed(0),
        isAchieved: item.isAchieved,
        earnedAmount: item.earnedAmount.toFixed(0),
      })),
      okrItems: record.okrItems.map((item) => ({
        id: item.id,
        employeeOkrId: item.employeeOkrId,
        goalType: item.goalTypeSnapshot,
        title: item.okrTitleSnapshot,
        progressPercent: item.progressPercent.toString(),
        thresholdPercent: item.achievementThresholdPercentSnapshot.toString(),
        rewardAmount: item.rewardAmountSnapshot.toFixed(0),
        isAchieved: item.isAchieved,
        earnedAmount: item.earnedAmount.toFixed(0),
      })),
      components: record.components.map((component) => ({
        id: component.id,
        code: component.componentCode,
        name: component.componentName,
        amount: component.amount.toFixed(0),
        note: component.note,
        source: component.source,
        createdAt: component.createdAt,
        createdBy: component.createdBy,
      })),
    };
  }

  private readWarnings(value: Prisma.JsonValue): SalaryWarning[] {
    return Array.isArray(value) ? (value as SalaryWarning[]) : [];
  }
}
