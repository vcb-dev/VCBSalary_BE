import {
  HttpStatus,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EmploymentStatus,
  PayrollPeriodStatus,
  Prisma,
  RewardRuleSetStatus,
  ScopeType,
  UserStatus,
} from '@prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  paginate,
  toSkipTake,
  type PaginationQueryDto,
} from '../../common/utils/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { currentBusinessDate } from '../../common/utils/date.util';
import type {
  CreatePayrollPeriodDto,
  ListPayrollPeriodsQueryDto,
  UpdatePayrollPeriodDto,
} from './dto/payroll-period.dto';

// Số tên nêu thẳng trong message lỗi (đủ để nhận ra ai mà không làm toast dài vô tận) và
// số bản ghi chi tiết trả kèm cho FE.
const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000;

const MAX_NAMES_IN_ERROR = 5;
const MAX_ISSUES_IN_DETAILS = 50;

type MembershipCheckEmployee = {
  id: number;
  employeeCode?: string;
  fullName: string;
  teamMemberships: Array<{
    isPrimary: boolean;
    defaultSalaryWeightPercent: Prisma.Decimal;
  }>;
};

type MembershipIssue = {
  id: number;
  employeeCode?: string;
  fullName: string;
  totalWeightPercent: string;
  activeTeamCount: number;
  primaryTeamCount: number;
  reasons: string[];
};

type EmployeeReadiness = {
  periodId: number;
  status: PayrollPeriodStatus;
  scope: MembershipCheckScope;
  ready: boolean;
  checkedEmployeeCount: number;
  invalidEmployeeCount: number;
  employees: MembershipIssue[];
};

type PreviousKpiTargets = {
  sourcePeriodCode: string | null;
  periodTargets: Array<{ kpiItemId: number; targetValue: Prisma.Decimal }>;
  employeeTargets: Array<{
    employeeId: number;
    teamId: number;
    kpiItemId: number;
    targetValue: Prisma.Decimal;
  }>;
};

// ALL: soi toàn bộ nhân sự còn làm việc (kỳ DRAFT sắp mở) · MISSING: chỉ người chưa snapshot
// (kỳ OPEN sắp đồng bộ) · NONE: kỳ đã qua giai đoạn snapshot nên không còn gì để kiểm.
type MembershipCheckScope = 'ALL' | 'MISSING' | 'NONE';

@Injectable()
export class PayrollPeriodsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PayrollPeriodsService.name);
  private autoOpenTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    // Mặc định để unit test dựng service với 2 tham số như cũ; Nest vẫn inject ConfigService thật.
    private readonly config: ConfigService = new ConfigService(),
  ) {}

  /**
   * Tự mở kỳ lương của tháng hiện tại. Timer nội bộ chỉ đóng vai trò trigger: tính đúng đắn nằm ở
   * unique key (payroll_year, payroll_month) của database và tính idempotent của
   * `ensureCurrentMonthOpen`, nên triển khai nhiều API instance vẫn an toàn.
   */
  async onApplicationBootstrap() {
    if (!this.isAutoOpenEnabled()) return;
    await this.runAutoOpen();
    const configured = Number(
      this.config.get<string>('PAYROLL_PERIOD_CHECK_INTERVAL_MS'),
    );
    const intervalMs =
      Number.isFinite(configured) && configured >= 60_000
        ? configured
        : DEFAULT_CHECK_INTERVAL_MS;
    this.autoOpenTimer = setInterval(() => void this.runAutoOpen(), intervalMs);
    this.autoOpenTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.autoOpenTimer) clearInterval(this.autoOpenTimer);
  }

  private isAutoOpenEnabled() {
    const configured = this.config.get<string>('PAYROLL_AUTO_OPEN_ENABLED');
    if (configured !== undefined) return configured.toLowerCase() === 'true';
    return this.config.get<string>('NODE_ENV') !== 'test';
  }

  private async runAutoOpen() {
    try {
      const period = await this.ensureCurrentMonthOpen();
      this.logger.log(
        `Kỳ lương tự động ${period.code} đang ở trạng thái ${period.status}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Chưa thể tự động mở kỳ lương tháng hiện tại: ${message}`,
      );
    }
  }

  list(query: ListPayrollPeriodsQueryDto) {
    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const where: Prisma.PayrollPeriodWhereInput = query.year
      ? { payrollYear: query.year }
      : {};
    return Promise.all([
      this.prisma.payrollPeriod.findMany({
        where,
        skip,
        take,
        orderBy: [{ payrollYear: 'desc' }, { payrollMonth: 'desc' }],
      }),
      this.prisma.payrollPeriod.count({ where }),
    ]).then(([data, total]) =>
      paginate(data, total, query.page, query.pageSize),
    );
  }

  async listYears(): Promise<number[]> {
    const rows = await this.prisma.payrollPeriod.findMany({
      distinct: ['payrollYear'],
      select: { payrollYear: true },
      orderBy: { payrollYear: 'desc' },
    });
    return rows.map((row) => row.payrollYear);
  }

  /**
   * Bảo đảm tháng nghiệp vụ hiện tại luôn có đúng một kỳ và kỳ đó đã được mở. Hàm cố ý
   * idempotent: scheduler có thể gọi lại nhiều lần hoặc nhiều instance có thể chạy đồng thời;
   * unique(payrollYear, payrollMonth) và state transition có điều kiện sẽ chặn bản ghi trùng.
   *
   * Nếu rule set hoặc hồ sơ nhân sự chưa sẵn sàng, bản ghi tháng vẫn được giữ ở DRAFT. Lần chạy
   * sau sẽ thử mở lại sau khi Admin sửa dữ liệu, không snapshot một trạng thái tổ chức sai.
   */
  async ensureCurrentMonthOpen(now: Date = new Date()) {
    const businessDate = currentBusinessDate(now);
    const { year, month } = this.monthKey(businessDate);
    let period = await this.prisma.payrollPeriod.findUnique({
      where: {
        payrollYear_payrollMonth: { payrollYear: year, payrollMonth: month },
      },
    });
    if (period && period.status !== PayrollPeriodStatus.DRAFT) return period;

    const actorUserId = await this.findAutomationActor();
    if (!actorUserId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Không tìm thấy tài khoản ACTIVE có quyền quản lý kỳ lương để chạy tự động',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!period) {
      const monthText = String(month).padStart(2, '0');
      const startDate = new Date(Date.UTC(year, month - 1, 1));
      const endDate = new Date(Date.UTC(year, month, 0));
      try {
        period = await this.prisma.$transaction(async (tx) => {
          const created = await tx.payrollPeriod.create({
            data: {
              code: `LUONG-${year}-${monthText}`,
              name: `Kỳ lương tháng ${monthText}/${year}`,
              payrollYear: year,
              payrollMonth: month,
              startDate,
              endDate,
            },
          });
          await this.auditLog.record(tx, {
            actorUserId,
            action: 'PAYROLL_PERIOD_CREATED',
            entityType: 'PayrollPeriod',
            entityId: created.id,
            payrollPeriodId: created.id,
            afterData: {
              ...payrollPeriodAuditSnapshot(created),
              creationSource: 'MONTHLY_AUTOMATION',
            },
          });
          return created;
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002'
        ) {
          throw error;
        }
        period = await this.prisma.payrollPeriod.findUnique({
          where: {
            payrollYear_payrollMonth: {
              payrollYear: year,
              payrollMonth: month,
            },
          },
        });
        if (!period) throw error;
      }
    }

    if (period.status !== PayrollPeriodStatus.DRAFT) return period;
    try {
      return await this.open(period.id, actorUserId);
    } catch (error) {
      // Một instance khác có thể vừa mở kỳ sau lần đọc phía trên.
      const latest = await this.prisma.payrollPeriod.findUnique({
        where: { id: period.id },
      });
      if (latest && latest.status !== PayrollPeriodStatus.DRAFT) return latest;
      throw error;
    }
  }

  private async findAutomationActor(): Promise<string | null> {
    const actor = await this.prisma.user.findFirst({
      where: {
        status: UserStatus.ACTIVE,
        userRoles: {
          some: {
            scopeType: ScopeType.ALL,
            role: {
              rolePermissions: {
                some: { permission: { code: 'payroll_period.manage' } },
              },
            },
          },
        },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return actor?.id ?? null;
  }

  async getOrThrow(id: number) {
    const period = await this.prisma.payrollPeriod.findUnique({
      where: { id },
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

  async create(dto: CreatePayrollPeriodDto, actorUserId?: string) {
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    this.assertDateRangeValid(startDate, endDate);
    const { year: payrollYear, month: payrollMonth } = this.assertMonthlyPeriod(
      startDate,
      endDate,
    );
    await this.assertNoOverlap(startDate, endDate);

    const latest = await this.prisma.payrollPeriod.aggregate({
      _max: { id: true },
    });
    const code = `KY-${String((latest._max.id ?? 0) + 1).padStart(6, '0')}`;

    const create = (db: PrismaService | Prisma.TransactionClient) =>
      db.payrollPeriod.create({
        data: {
          code,
          name: dto.name,
          payrollYear,
          payrollMonth,
          startDate,
          endDate,
          approvalDeadline: dto.approvalDeadline
            ? new Date(dto.approvalDeadline)
            : undefined,
        },
      });
    if (!actorUserId) return create(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      const created = await create(tx);
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'PAYROLL_PERIOD_CREATED',
        entityType: 'PayrollPeriod',
        entityId: created.id,
        payrollPeriodId: created.id,
        afterData: payrollPeriodAuditSnapshot(created),
      });
      return created;
    });
  }

  async update(id: number, dto: UpdatePayrollPeriodDto, actorUserId?: string) {
    const period = await this.getOrThrow(id);
    this.assertStatus(
      period.status,
      PayrollPeriodStatus.DRAFT,
      'Chỉ có thể sửa kỳ khi đang ở trạng thái DRAFT',
    );

    const startDate = dto.startDate
      ? new Date(dto.startDate)
      : period.startDate;
    const endDate = dto.endDate ? new Date(dto.endDate) : period.endDate;
    if (dto.startDate || dto.endDate) {
      this.assertDateRangeValid(startDate, endDate);
      this.assertMonthlyPeriod(startDate, endDate);
      await this.assertNoOverlap(startDate, endDate, id);
    }
    const { year: payrollYear, month: payrollMonth } = this.monthKey(startDate);

    const update = (db: PrismaService | Prisma.TransactionClient) =>
      db.payrollPeriod.update({
        where: { id },
        data: {
          name: dto.name,
          payrollYear: dto.startDate ? payrollYear : undefined,
          payrollMonth: dto.startDate ? payrollMonth : undefined,
          startDate: dto.startDate ? startDate : undefined,
          endDate: dto.endDate ? endDate : undefined,
          approvalDeadline:
            dto.approvalDeadline === null
              ? null
              : dto.approvalDeadline
                ? new Date(dto.approvalDeadline)
                : undefined,
        },
      });
    if (!actorUserId) return update(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      const updated = await update(tx);
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'PAYROLL_PERIOD_UPDATED',
        entityType: 'PayrollPeriod',
        entityId: id,
        payrollPeriodId: id,
        beforeData: payrollPeriodAuditSnapshot(period),
        afterData: payrollPeriodAuditSnapshot(updated),
      });
      return updated;
    });
  }

  async open(id: number, actorUserId: string) {
    const period = await this.getOrThrow(id);
    this.assertTransition(
      period.status,
      PayrollPeriodStatus.DRAFT,
      PayrollPeriodStatus.OPEN,
    );

    // M05: kỳ lương phải gắn với đúng 1 Reward Rule Set đang ACTIVE tại thời điểm mở — hoãn từ
    // M04 (lúc đó bảng reward_rule_sets chưa tồn tại). Không cho mở kỳ nếu chưa có version nào
    // ACTIVE — Admin phải tạo + activate reward rule set trước.
    const activeRuleSet = await this.prisma.rewardRuleSet.findFirst({
      where: { status: RewardRuleSetStatus.ACTIVE },
    });
    if (!activeRuleSet) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Cần có một Reward Rule Set đang ACTIVE trước khi mở kỳ lương',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Chỉ snapshot nhân sự còn thuộc tổ chức tại thời điểm mở kỳ — người đã LEFT không được
    // đưa vào một kỳ lương mới. Đọc trước transaction: đây là thao tác Admin chủ động trigger,
    // chấp nhận rủi ro nhỏ nếu có thay đổi nhân sự đúng lúc đang mở kỳ.
    const employees = await this.prisma.employee.findMany({
      where: { employmentStatus: { not: EmploymentStatus.LEFT } },
      include: {
        team: true,
        leader: true,
        manager: true,
        employeeGroups: { select: { id: true, code: true } },
        teamMemberships: {
          where: { isActive: true },
          include: { team: true, leader: true, manager: true },
        },
      },
    });
    this.assertMembershipWeights(employees);
    const automaticKpiGroups = await this.prisma.kpiGroup.findMany({
      where: { isActive: true },
      include: {
        teams: { select: { id: true } },
        applicableEmployeeGroups: { select: { id: true } },
        items: { where: { isActive: true }, select: { id: true } },
      },
    });
    const automaticAssignments = employees.flatMap((employee) =>
      employee.teamMemberships.flatMap((membership) =>
        automaticKpiGroups
          .filter(
            (group) =>
              group.applicableEmployeeGroups.length > 0 &&
              ((group.teams ?? []).length === 0 ||
                (group.teams ?? []).some(
                  (team) => team.id === membership.teamId,
                )) &&
              group.applicableEmployeeGroups.some((applicableGroup) =>
                employee.employeeGroups.some(
                  (employeeGroup) => employeeGroup.id === applicableGroup.id,
                ),
              ),
          )
          .map((group) => ({ employee, membership, group })),
      ),
    );
    const previousTargets = await this.loadPreviousKpiTargets(
      period,
      automaticAssignments.map(({ employee, membership, group }) => ({
        employeeId: employee.id,
        teamId: membership.teamId,
        kpiGroupId: group.id,
      })),
    );

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payrollPeriod.updateMany({
        where: { id, status: PayrollPeriodStatus.DRAFT },
        data: {
          status: PayrollPeriodStatus.OPEN,
          openedByUserId: actorUserId,
          openedAt: new Date(),
          rewardRuleSetId: activeRuleSet.id,
        },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Kỳ lương vừa được mở hoặc thay đổi bởi một yêu cầu khác',
          HttpStatus.CONFLICT,
        );
      }
      const updated = await tx.payrollPeriod.findUniqueOrThrow({
        where: { id },
      });

      if (employees.length > 0) {
        await tx.payrollPeriodEmployeeSnapshot.createMany({
          data: employees.map((employee) => ({
            payrollPeriodId: id,
            employeeId: employee.id,
            employeeCodeSnapshot: employee.employeeCode,
            employeeNameSnapshot: employee.fullName,
            jobTitleSnapshot: employee.jobTitle,
            employeeGroupsSnapshot: employee.employeeGroups.map(
              (group) => group.code,
            ),
            teamIdSnapshot: employee.teamId,
            teamCodeSnapshot: employee.team.code,
            teamNameSnapshot: employee.team.name,
            leaderEmployeeIdSnapshot: employee.leaderEmployeeId,
            leaderNameSnapshot: employee.leader?.fullName ?? null,
            managerEmployeeIdSnapshot: employee.managerEmployeeId,
            managerNameSnapshot: employee.manager?.fullName ?? null,
            employmentStatusSnapshot: employee.employmentStatus,
          })),
        });
        const createdSnapshots =
          await tx.payrollPeriodEmployeeSnapshot.findMany({
            where: { payrollPeriodId: id },
            select: { id: true, employeeId: true },
          });
        const snapshotIdByEmployee = new Map(
          createdSnapshots.map((snapshot) => [
            snapshot.employeeId,
            snapshot.id,
          ]),
        );
        await tx.payrollPeriodEmployeeTeamSnapshot.createMany({
          data: employees.flatMap((employee) =>
            employee.teamMemberships.map((membership) => ({
              payrollPeriodId: id,
              employeeSnapshotId: snapshotIdByEmployee.get(employee.id)!,
              employeeId: employee.id,
              membershipId: membership.id,
              teamId: membership.teamId,
              teamCodeSnapshot: membership.team.code,
              teamNameSnapshot: membership.team.name,
              isPrimary: membership.isPrimary,
              salaryWeightPercent: membership.defaultSalaryWeightPercent,
              leaderEmployeeIdSnapshot: membership.leaderEmployeeId,
              leaderNameSnapshot: membership.leader?.fullName ?? null,
              managerEmployeeIdSnapshot: membership.managerEmployeeId,
              managerNameSnapshot: membership.manager?.fullName ?? null,
            })),
          ),
        });
      }

      if (automaticAssignments.length > 0) {
        await tx.employeeKpiAssignment.createMany({
          data: automaticAssignments.map(({ employee, membership, group }) => ({
            employeeId: employee.id,
            teamId: membership.teamId,
            kpiGroupId: group.id,
            payrollPeriodId: id,
            assignedByUserId: actorUserId,
          })),
          skipDuplicates: true,
        });

        const actualRows = automaticAssignments.flatMap(
          ({ employee, membership, group }) =>
            group.items.map((item) => ({
              employeeId: employee.id,
              teamId: membership.teamId,
              kpiItemId: item.id,
              payrollPeriodId: id,
            })),
        );
        if (actualRows.length > 0) {
          await tx.employeeKpiActual.createMany({
            data: actualRows,
            skipDuplicates: true,
          });
        }
      }

      // Bản chép giữ nguồn MANUAL mặc định: leader vẫn sửa được, còn đồng bộ VCBI upsert ghi đè
      // ngay khi nguồn có target (nguồn trả target rỗng thì sync giữ nguyên giá trị đã chép).
      const copiedPeriodTargets =
        previousTargets.periodTargets.length > 0
          ? await tx.kpiPeriodTarget.createMany({
              data: previousTargets.periodTargets.map((target) => ({
                ...target,
                payrollPeriodId: id,
                createdByUserId: actorUserId,
              })),
              skipDuplicates: true,
            })
          : { count: 0 };
      const copiedEmployeeTargets =
        previousTargets.employeeTargets.length > 0
          ? await tx.employeeKpiTarget.createMany({
              data: previousTargets.employeeTargets.map((target) => ({
                ...target,
                payrollPeriodId: id,
                createdByUserId: actorUserId,
              })),
              skipDuplicates: true,
            })
          : { count: 0 };

      await this.auditLog.record(tx, {
        actorUserId,
        action: 'PAYROLL_PERIOD_OPENED',
        entityType: 'PayrollPeriod',
        entityId: id,
        payrollPeriodId: id,
        beforeData: { status: period.status },
        afterData: {
          status: PayrollPeriodStatus.OPEN,
          snapshotEmployeeCount: employees.length,
          automaticKpiAssignmentCount: automaticAssignments.length,
          kpiTargetSourcePeriodCode: previousTargets.sourcePeriodCode,
          copiedKpiPeriodTargetCount: copiedPeriodTargets.count,
          copiedEmployeeKpiTargetCount: copiedEmployeeTargets.count,
          rewardRuleSetId: activeRuleSet.id,
          rewardRuleSetVersion: activeRuleSet.version,
        },
      });

      return {
        ...updated,
        automaticKpiAssignmentCount: automaticAssignments.length,
        copiedKpiTargetCount:
          copiedPeriodTargets.count + copiedEmployeeTargets.count,
      };
    });
  }

  /**
   * KPI của nhân sự hiếm khi đổi giữa các tháng, nên kỳ mới lấy mục tiêu gốc của kỳ gần nhất
   * trước đó làm giá trị khởi tạo. Chỉ chép đầu mục cấu hình nội bộ còn active, và với mục tiêu
   * riêng thì chỉ khi (nhân sự, team, nhóm KPI) vừa được tự gán lại trong kỳ mới. KPI riêng từ
   * VCBI (externalItemId) do đồng bộ tự tạo theo từng tháng nên không chép; giá trị điều chỉnh
   * (override) gắn với lý do của kỳ cũ nên cũng không mang sang.
   */
  private async loadPreviousKpiTargets(
    period: { payrollYear: number; payrollMonth: number },
    assignments: Array<{
      employeeId: number;
      teamId: number;
      kpiGroupId: number;
    }>,
  ): Promise<PreviousKpiTargets> {
    const previous = await this.prisma.payrollPeriod.findFirst({
      where: {
        status: { not: PayrollPeriodStatus.DRAFT },
        OR: [
          { payrollYear: { lt: period.payrollYear } },
          {
            payrollYear: period.payrollYear,
            payrollMonth: { lt: period.payrollMonth },
          },
        ],
      },
      orderBy: [{ payrollYear: 'desc' }, { payrollMonth: 'desc' }],
      select: { id: true, code: true },
    });
    if (!previous) {
      return { sourcePeriodCode: null, periodTargets: [], employeeTargets: [] };
    }

    const copyableItem: Prisma.KpiItemWhereInput = {
      isActive: true,
      externalItemId: null,
      kpiGroup: { isActive: true },
    };
    const [periodTargets, employeeTargets] = await Promise.all([
      this.prisma.kpiPeriodTarget.findMany({
        where: { payrollPeriodId: previous.id, kpiItem: copyableItem },
        select: { kpiItemId: true, targetValue: true },
      }),
      this.prisma.employeeKpiTarget.findMany({
        where: { payrollPeriodId: previous.id, kpiItem: copyableItem },
        select: {
          employeeId: true,
          teamId: true,
          kpiItemId: true,
          targetValue: true,
          kpiItem: { select: { kpiGroupId: true } },
        },
      }),
    ]);
    const assigned = new Set(
      assignments.map(
        (assignment) =>
          `${assignment.employeeId}:${assignment.teamId}:${assignment.kpiGroupId}`,
      ),
    );
    return {
      sourcePeriodCode: previous.code,
      periodTargets,
      employeeTargets: employeeTargets
        .filter((target) =>
          assigned.has(
            `${target.employeeId}:${target.teamId}:${target.kpiItem.kpiGroupId}`,
          ),
        )
        .map(({ employeeId, teamId, kpiItemId, targetValue }) => ({
          employeeId,
          teamId,
          kpiItemId,
          targetValue,
        })),
    };
  }

  /**
   * Bổ sung nhân sự MỚI (được tạo sau khi kỳ đã mở) vào snapshot của kỳ — chỉ thêm dòng còn thiếu,
   * KHÔNG đụng tới snapshot đã có (đúng nguyên tắc "snapshot ghi 1 lần, không tự tính lại" đã ghi ở
   * M04: nhân sự đổi team sau khi đã snapshot thì snapshot cũ vẫn giữ nguyên team cũ). Chỉ cho phép
   * khi kỳ còn OPEN — IN_REVIEW là giai đoạn khóa dữ liệu để duyệt, không thêm nhân sự mới giữa
   * chừng; DRAFT/CLOSED không có snapshot để đồng bộ hoặc đã khóa hẳn.
   */
  async syncEmployeeSnapshots(id: number, actorUserId: string) {
    const period = await this.getOrThrow(id);
    this.assertStatus(
      period.status,
      PayrollPeriodStatus.OPEN,
      'Chỉ có thể đồng bộ danh sách nhân sự khi kỳ đang OPEN',
    );

    const existingSnapshots =
      await this.prisma.payrollPeriodEmployeeSnapshot.findMany({
        where: { payrollPeriodId: id },
        select: { employeeId: true },
      });
    const snapshottedIds = new Set(existingSnapshots.map((s) => s.employeeId));

    const activeEmployees = await this.prisma.employee.findMany({
      where: { employmentStatus: { not: EmploymentStatus.LEFT } },
      include: {
        team: true,
        leader: true,
        manager: true,
        employeeGroups: { select: { id: true, code: true } },
        teamMemberships: {
          where: { isActive: true },
          include: { team: true, leader: true, manager: true },
        },
      },
    });
    const missingEmployees = activeEmployees.filter(
      (employee) => !snapshottedIds.has(employee.id),
    );
    this.assertMembershipWeights(missingEmployees);

    if (missingEmployees.length === 0) {
      return {
        addedCount: 0,
        addedEmployeeNames: [],
        automaticKpiAssignmentCount: 0,
      };
    }

    const automaticKpiGroups = await this.prisma.kpiGroup.findMany({
      where: { isActive: true },
      include: {
        teams: { select: { id: true } },
        applicableEmployeeGroups: { select: { id: true } },
        items: { where: { isActive: true }, select: { id: true } },
      },
    });
    const automaticAssignments = missingEmployees.flatMap((employee) =>
      employee.teamMemberships.flatMap((membership) =>
        automaticKpiGroups
          .filter(
            (group) =>
              group.applicableEmployeeGroups.length > 0 &&
              ((group.teams ?? []).length === 0 ||
                (group.teams ?? []).some(
                  (team) => team.id === membership.teamId,
                )) &&
              group.applicableEmployeeGroups.some((applicableGroup) =>
                employee.employeeGroups.some(
                  (employeeGroup) => employeeGroup.id === applicableGroup.id,
                ),
              ),
          )
          .map((group) => ({ employee, membership, group })),
      ),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.payrollPeriodEmployeeSnapshot.createMany({
        data: missingEmployees.map((employee) => ({
          payrollPeriodId: id,
          employeeId: employee.id,
          employeeCodeSnapshot: employee.employeeCode,
          employeeNameSnapshot: employee.fullName,
          jobTitleSnapshot: employee.jobTitle,
          employeeGroupsSnapshot: employee.employeeGroups.map(
            (group) => group.code,
          ),
          teamIdSnapshot: employee.teamId,
          teamCodeSnapshot: employee.team.code,
          teamNameSnapshot: employee.team.name,
          leaderEmployeeIdSnapshot: employee.leaderEmployeeId,
          leaderNameSnapshot: employee.leader?.fullName ?? null,
          managerEmployeeIdSnapshot: employee.managerEmployeeId,
          managerNameSnapshot: employee.manager?.fullName ?? null,
          employmentStatusSnapshot: employee.employmentStatus,
        })),
        skipDuplicates: true,
      });
      const createdSnapshots = await tx.payrollPeriodEmployeeSnapshot.findMany({
        where: {
          payrollPeriodId: id,
          employeeId: { in: missingEmployees.map((employee) => employee.id) },
        },
        select: { id: true, employeeId: true },
      });
      const snapshotIdByEmployee = new Map(
        createdSnapshots.map((snapshot) => [snapshot.employeeId, snapshot.id]),
      );
      await tx.payrollPeriodEmployeeTeamSnapshot.createMany({
        data: missingEmployees.flatMap((employee) =>
          employee.teamMemberships.map((membership) => ({
            payrollPeriodId: id,
            employeeSnapshotId: snapshotIdByEmployee.get(employee.id)!,
            employeeId: employee.id,
            membershipId: membership.id,
            teamId: membership.teamId,
            teamCodeSnapshot: membership.team.code,
            teamNameSnapshot: membership.team.name,
            isPrimary: membership.isPrimary,
            salaryWeightPercent: membership.defaultSalaryWeightPercent,
            leaderEmployeeIdSnapshot: membership.leaderEmployeeId,
            leaderNameSnapshot: membership.leader?.fullName ?? null,
            managerEmployeeIdSnapshot: membership.managerEmployeeId,
            managerNameSnapshot: membership.manager?.fullName ?? null,
          })),
        ),
        skipDuplicates: true,
      });

      if (automaticAssignments.length > 0) {
        await tx.employeeKpiAssignment.createMany({
          data: automaticAssignments.map(({ employee, membership, group }) => ({
            employeeId: employee.id,
            teamId: membership.teamId,
            kpiGroupId: group.id,
            payrollPeriodId: id,
            assignedByUserId: actorUserId,
          })),
          skipDuplicates: true,
        });
        const actualRows = automaticAssignments.flatMap(
          ({ employee, membership, group }) =>
            group.items.map((item) => ({
              employeeId: employee.id,
              teamId: membership.teamId,
              kpiItemId: item.id,
              payrollPeriodId: id,
            })),
        );
        if (actualRows.length > 0) {
          await tx.employeeKpiActual.createMany({
            data: actualRows,
            skipDuplicates: true,
          });
        }
      }
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'PAYROLL_PERIOD_SNAPSHOTS_SYNCED',
        entityType: 'PayrollPeriod',
        entityId: id,
        payrollPeriodId: id,
        afterData: {
          addedCount: missingEmployees.length,
          addedEmployeeIds: missingEmployees.map((e) => e.id),
          automaticKpiAssignmentCount: automaticAssignments.length,
        },
      });
    });

    return {
      addedCount: missingEmployees.length,
      addedEmployeeNames: missingEmployees.map((e) => e.fullName),
      automaticKpiAssignmentCount: automaticAssignments.length,
    };
  }

  async startReview(id: number, actorUserId: string) {
    const period = await this.getOrThrow(id);
    this.assertTransition(
      period.status,
      PayrollPeriodStatus.OPEN,
      PayrollPeriodStatus.IN_REVIEW,
    );

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payrollPeriod.updateMany({
        where: { id, status: PayrollPeriodStatus.OPEN },
        data: { status: PayrollPeriodStatus.IN_REVIEW },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Kỳ lương vừa được thay đổi bởi một yêu cầu khác',
          HttpStatus.CONFLICT,
        );
      }
      const updated = await tx.payrollPeriod.findUniqueOrThrow({
        where: { id },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'PAYROLL_PERIOD_START_REVIEW',
        entityType: 'PayrollPeriod',
        entityId: id,
        payrollPeriodId: id,
        beforeData: { status: period.status },
        afterData: { status: PayrollPeriodStatus.IN_REVIEW },
      });
      return updated;
    });
  }

  async close(id: number, actorUserId: string) {
    const period = await this.getOrThrow(id);
    this.assertTransition(
      period.status,
      PayrollPeriodStatus.IN_REVIEW,
      PayrollPeriodStatus.CLOSED,
    );

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const [snapshots, salaryRecords] = await Promise.all([
            tx.payrollPeriodEmployeeSnapshot.findMany({
              where: { payrollPeriodId: id },
              select: { employeeId: true },
            }),
            tx.salaryRecord.findMany({
              where: { payrollPeriodId: id },
              orderBy: { versionNumber: 'desc' },
              select: { employeeId: true, status: true, versionNumber: true },
            }),
          ]);
          const latestByEmployee = new Map<
            number,
            (typeof salaryRecords)[number]
          >();
          for (const record of salaryRecords) {
            if (!latestByEmployee.has(record.employeeId)) {
              latestByEmployee.set(record.employeeId, record);
            }
          }
          const notLockedEmployeeIds = snapshots
            .map((snapshot) => snapshot.employeeId)
            .filter(
              (employeeId) =>
                latestByEmployee.get(employeeId)?.status !== 'LOCKED',
            );
          if (notLockedEmployeeIds.length > 0) {
            throw new AppException(
              ErrorCode.VALIDATION_ERROR,
              'Chưa thể đóng kỳ: còn nhân sự chưa có bản lương được duyệt và khóa',
              HttpStatus.BAD_REQUEST,
              {
                count: notLockedEmployeeIds.length,
                employeeIds: notLockedEmployeeIds.slice(0, 100),
              },
            );
          }

          const closedAt = new Date();
          const claimed = await tx.payrollPeriod.updateMany({
            where: { id, status: PayrollPeriodStatus.IN_REVIEW },
            data: { status: PayrollPeriodStatus.CLOSED, closedAt },
          });
          if (claimed.count !== 1) {
            throw new AppException(
              ErrorCode.CONFLICT,
              'Kỳ lương vừa được thay đổi bởi một yêu cầu khác',
              HttpStatus.CONFLICT,
            );
          }
          const updated = await tx.payrollPeriod.findUniqueOrThrow({
            where: { id },
          });
          await this.auditLog.record(tx, {
            actorUserId,
            action: 'PAYROLL_PERIOD_CLOSED',
            entityType: 'PayrollPeriod',
            entityId: id,
            payrollPeriodId: id,
            beforeData: { status: period.status },
            afterData: { status: PayrollPeriodStatus.CLOSED },
          });
          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Dữ liệu kỳ lương vừa thay đổi, vui lòng thực hiện lại',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async listEmployeeSnapshots(id: number, query: PaginationQueryDto) {
    await this.getOrThrow(id);
    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const where: Prisma.PayrollPeriodEmployeeSnapshotWhereInput = {
      payrollPeriodId: id,
    };
    const [data, total] = await Promise.all([
      this.prisma.payrollPeriodEmployeeSnapshot.findMany({
        where,
        skip,
        take,
        orderBy: { employeeNameSnapshot: 'asc' },
        include: {
          teamSnapshots: {
            orderBy: [{ isPrimary: 'desc' }, { teamNameSnapshot: 'asc' }],
          },
        },
      }),
      this.prisma.payrollPeriodEmployeeSnapshot.count({ where }),
    ]);
    return paginate(data, total, query.page, query.pageSize);
  }

  private assertStatus(
    current: PayrollPeriodStatus,
    required: PayrollPeriodStatus,
    message: string,
  ) {
    if (current !== required) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        message,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Liệt kê nhân sự chưa đủ điều kiện snapshot kèm lý do cụ thể. Dùng chung cho cả hai đường:
   * chặn cứng lúc mở kỳ/đồng bộ (assertMembershipWeights) và tiền kiểm để Admin sửa trước
   * (getEmployeeReadiness) — để hai nơi không bao giờ lệch luật với nhau.
   */
  private collectMembershipIssues(
    employees: MembershipCheckEmployee[],
  ): MembershipIssue[] {
    const issues: MembershipIssue[] = [];
    for (const employee of employees) {
      const memberships = employee.teamMemberships;
      const total = memberships.reduce(
        (sum, membership) => sum.plus(membership.defaultSalaryWeightPercent),
        new Prisma.Decimal(0),
      );
      const primaryCount = memberships.filter(
        (membership) => membership.isPrimary,
      ).length;
      const reasons: string[] = [];
      if (memberships.length === 0) {
        reasons.push('Chưa thuộc team nào đang hoạt động');
      } else if (primaryCount === 0) {
        reasons.push('Chưa có team chính');
      } else if (primaryCount > 1) {
        reasons.push(`Đang có ${primaryCount} team chính, chỉ được phép 1`);
      }
      if (memberships.length > 0 && !total.equals(100)) {
        reasons.push(
          `Tổng tỷ trọng KPI đang là ${total.toString()}%, phải bằng 100%`,
        );
      }
      if (reasons.length === 0) continue;
      issues.push({
        id: employee.id,
        employeeCode: employee.employeeCode,
        fullName: employee.fullName,
        totalWeightPercent: total.toString(),
        activeTeamCount: memberships.length,
        primaryTeamCount: primaryCount,
        reasons,
      });
    }
    return issues;
  }

  private assertMembershipWeights(employees: MembershipCheckEmployee[]) {
    const invalid = this.collectMembershipIssues(employees);
    if (invalid.length === 0) return;
    // Nêu thẳng tên người vi phạm trong message: FE chỉ hiển thị message ở toast, không đọc
    // details, nên nếu chỉ nói chung chung thì Admin không biết phải sửa hồ sơ của ai.
    const names = invalid
      .slice(0, MAX_NAMES_IN_ERROR)
      .map((issue) => issue.fullName)
      .join(', ');
    const remaining =
      invalid.length - Math.min(invalid.length, MAX_NAMES_IN_ERROR);
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Chưa thể snapshot: ${invalid.length} nhân sự chưa đạt điều kiện (mỗi người phải có đúng một team chính và tổng tỷ trọng KPI bằng 100%) — ${names}${
        remaining > 0 ? ` và ${remaining} người khác` : ''
      }`,
      HttpStatus.BAD_REQUEST,
      { employees: invalid.slice(0, MAX_ISSUES_IN_DETAILS) },
    );
  }

  /**
   * Tiền kiểm dữ liệu nhân sự trước khi mở kỳ / đồng bộ — trả về đúng danh sách người cần sửa
   * thay vì để Admin bấm nút rồi mới nhận lỗi. Phạm vi soi bám theo trạng thái kỳ: DRAFT soi
   * toàn bộ nhân sự còn làm việc (đúng tập mà open sẽ snapshot), OPEN chỉ soi người chưa có
   * trong snapshot (đúng tập mà sync sẽ thêm).
   */
  async getEmployeeReadiness(id: number): Promise<EmployeeReadiness> {
    const period = await this.getOrThrow(id);
    const scope: MembershipCheckScope =
      period.status === PayrollPeriodStatus.DRAFT
        ? 'ALL'
        : period.status === PayrollPeriodStatus.OPEN
          ? 'MISSING'
          : 'NONE';
    if (scope === 'NONE') {
      return {
        periodId: id,
        status: period.status,
        scope,
        ready: true,
        checkedEmployeeCount: 0,
        invalidEmployeeCount: 0,
        employees: [],
      };
    }

    let snapshottedIds = new Set<number>();
    if (scope === 'MISSING') {
      const existingSnapshots =
        await this.prisma.payrollPeriodEmployeeSnapshot.findMany({
          where: { payrollPeriodId: id },
          select: { employeeId: true },
        });
      snapshottedIds = new Set(
        existingSnapshots.map((snapshot) => snapshot.employeeId),
      );
    }

    const employees = await this.prisma.employee.findMany({
      where: { employmentStatus: { not: EmploymentStatus.LEFT } },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        teamMemberships: {
          where: { isActive: true },
          select: { isPrimary: true, defaultSalaryWeightPercent: true },
        },
      },
      orderBy: { fullName: 'asc' },
    });
    const candidates = employees.filter(
      (employee) => !snapshottedIds.has(employee.id),
    );
    const invalid = this.collectMembershipIssues(candidates);
    return {
      periodId: id,
      status: period.status,
      scope,
      ready: invalid.length === 0,
      checkedEmployeeCount: candidates.length,
      invalidEmployeeCount: invalid.length,
      employees: invalid.slice(0, MAX_ISSUES_IN_DETAILS),
    };
  }

  private assertTransition(
    current: PayrollPeriodStatus,
    from: PayrollPeriodStatus,
    to: PayrollPeriodStatus,
  ) {
    if (current !== from) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Không thể chuyển kỳ sang ${to} — trạng thái hiện tại là ${current}, yêu cầu đang ở ${from}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertDateRangeValid(startDate: Date, endDate: Date) {
    if (startDate.getTime() >= endDate.getTime()) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'startDate phải trước endDate',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private monthKey(date: Date) {
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  }

  /** Kỳ lương từ nay luôn bám trọn một tháng dương lịch để thống kê năm có đúng tối đa 12 điểm. */
  private assertMonthlyPeriod(startDate: Date, endDate: Date) {
    const key = this.monthKey(startDate);
    const expectedStart = new Date(Date.UTC(key.year, key.month - 1, 1));
    const expectedEnd = new Date(Date.UTC(key.year, key.month, 0));
    if (
      startDate.getTime() !== expectedStart.getTime() ||
      endDate.getTime() !== expectedEnd.getTime()
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Kỳ lương phải bắt đầu ngày đầu tháng và kết thúc ngày cuối cùng của cùng tháng',
        HttpStatus.BAD_REQUEST,
      );
    }
    return key;
  }

  /** Chặn 2 kỳ có khoảng ngày chồng lấn — "nên" theo business rule (nghiệp vụ theo tháng). */
  private async assertNoOverlap(
    startDate: Date,
    endDate: Date,
    excludePeriodId?: number,
  ) {
    const overlapping = await this.prisma.payrollPeriod.findFirst({
      where: {
        id: excludePeriodId ? { not: excludePeriodId } : undefined,
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
    });
    if (overlapping) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Khoảng ngày chồng lấn với kỳ "${overlapping.code}"`,
        HttpStatus.BAD_REQUEST,
        { conflictingPeriodId: overlapping.id },
      );
    }
  }
}

function payrollPeriodAuditSnapshot(period: {
  code: string;
  name: string;
  startDate: Date;
  endDate: Date;
  approvalDeadline: Date | null;
  status: PayrollPeriodStatus;
}): Prisma.InputJsonObject {
  return {
    code: period.code,
    name: period.name,
    startDate: period.startDate.toISOString(),
    endDate: period.endDate.toISOString(),
    approvalDeadline: period.approvalDeadline?.toISOString() ?? null,
    status: period.status,
  };
}
