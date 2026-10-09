import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  type EmployeeKpiActual,
  type EmployeeKpiTarget,
  type KpiSyncItemStatus,
} from '@prisma/client';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { forEachConcurrent } from '../../../common/utils/for-each-concurrent';
import {
  paginate,
  toSkipTake,
  type PaginationQueryDto,
} from '../../../common/utils/pagination.dto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthorizationService } from '../../access-control/authorization.service';
import type { ResolvedScope } from '../../../common/types/resolved-scope.types';
import { AuditLogService } from '../../audit/audit-log.service';
import {
  AutomationGenVideoClient,
  type AutomationGenVideoKpiRecord,
  type AutomationGenVideoPerformanceGoalRecord,
} from '../../../common/clients/automation-gen-video.client';
import { matchEmployeesByEmailOrName } from '../../../common/utils/employee-identity-matcher';
import { buildLinkedTeamScopeWhere } from '../../../common/utils/linked-team-scope.util';
import type { TriggerKpiSyncDto } from './dto/kpi-sync.dto';

type ResolvedRecord = {
  source: AutomationGenVideoKpiRecord;
  teamId: number;
  employeeId?: number;
  kpiItemId?: number;
  groupId?: number;
  reason?: string;
  previousTarget?: ExistingKpiTarget | null;
  previousActual?: ExistingKpiActual | null;
};

type ExistingKpiTarget = Pick<
  EmployeeKpiTarget,
  'id' | 'employeeId' | 'kpiItemId' | 'targetValue' | 'overrideValue'
>;
type ExistingKpiActual = Pick<
  EmployeeKpiActual,
  | 'id'
  | 'employeeId'
  | 'kpiItemId'
  | 'actualValue'
  | 'dataSource'
  | 'manualEnteredAt'
  | 'selfConfirmationStatus'
  | 'leaderReviewStatus'
>;

type ResolvedPerformanceGoal = {
  source: AutomationGenVideoPerformanceGoalRecord;
  teamId: number;
  employeeId?: number;
  reason?: string;
  previous?: {
    id: number;
    targetValue: Prisma.Decimal;
    actualValue: Prisma.Decimal;
    rewardAmount: Prisma.Decimal;
  } | null;
};

// Mỗi record có tối đa hai nhánh ghi DB độc lập (TARGET và ACTUAL). Giới hạn số record xử lý
// đồng thời để giảm thời gian round-trip nhưng không làm đầy connection pool của Prisma/Postgres.
const KPI_SYNC_RECORD_CONCURRENCY = 4;
const SOURCE_SYSTEM = 'AUTOMATION_GEN_VIDEO';

@Injectable()
export class KpiSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceClient: AutomationGenVideoClient,
    private readonly auditLog: AuditLogService,
    private readonly authorization: AuthorizationService,
  ) {}

  async sync(dto: TriggerKpiSyncDto, actorUserId: string) {
    const [period, team, scope] = await Promise.all([
      this.prisma.payrollPeriod.findUnique({
        where: { id: dto.payrollPeriodId },
      }),
      this.prisma.team.findUnique({
        where: { externalId: dto.externalTeamId },
      }),
      this.authorization.resolvePermissionScope(actorUserId, 'sync.trigger'),
    ]);
    if (!period) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy kỳ lương',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!team) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Team chưa được đồng bộ từ VCBI. Hãy đồng bộ cơ cấu tổ chức trước.',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Leader được cấp sync.trigger qua role scope TEAM chỉ được chạy cho team mình quản lý.
    if (!this.scopeIncludesTeam(scope, team.id)) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Bạn chỉ được đồng bộ KPI cho team thuộc phạm vi quản lý của mình',
        HttpStatus.FORBIDDEN,
      );
    }

    const month = `${period.startDate.getUTCFullYear()}-${String(period.startDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const running = await this.prisma.kpiSyncRun.findFirst({
      where: { externalTeamId: dto.externalTeamId, month, status: 'RUNNING' },
    });
    if (running) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Team và tháng này đang có một lượt đồng bộ KPI khác chạy',
        HttpStatus.CONFLICT,
      );
    }

    const run = await this.prisma.kpiSyncRun.create({
      data: {
        externalTeamId: dto.externalTeamId,
        payrollPeriodId: period.id,
        month,
        triggeredByUserId: actorUserId,
      },
    });

    // Đồng bộ chỉ chạy trong giai đoạn nhập liệu của kỳ. Từ IN_REVIEW trở đi con số phải đứng
    // yên để Leader duyệt, nên run vẫn được ghi lại (có lịch sử ai bấm, lúc nào) nhưng SKIPPED.
    if (period.status !== 'OPEN') {
      return this.prisma.kpiSyncRun.update({
        where: { id: run.id },
        data: {
          status: 'SKIPPED',
          finishedAt: new Date(),
          errorSummary:
            period.status === 'CLOSED'
              ? 'Kỳ lương đã đóng nên dữ liệu được bảo vệ'
              : 'Chỉ đồng bộ KPI khi kỳ lương đang mở',
        },
        include: this.runInclude,
      });
    }

    try {
      const [payload, performanceGoalPayload] = await Promise.all([
        this.sourceClient.fetchKpisForPayrollSync(dto.externalTeamId, month),
        this.sourceClient.fetchPerformanceGoalsForPayrollSync(
          dto.externalTeamId,
          month,
        ),
      ]);
      this.validatePayload(payload, dto.externalTeamId, month);
      this.validatePayload(performanceGoalPayload, dto.externalTeamId, month);

      const performanceKpis = performanceGoalPayload.records.filter(
        (record) => record.item_type === 'KPI',
      );
      const performanceOkrs = performanceGoalPayload.records.filter(
        (record) => record.item_type === 'OKR',
      );
      const [resolved, resolvedPerformanceKpis, resolvedPerformanceGoals] =
        await Promise.all([
          this.resolveRecords(
            team.id,
            dto.externalTeamId,
            period.id,
            payload.records,
          ),
          this.resolvePerformanceKpis(
            team.id,
            period.id,
            actorUserId,
            performanceKpis,
          ),
          this.resolvePerformanceGoals(team.id, period.id, performanceOkrs),
        ]);
      await forEachConcurrent(
        [...resolved, ...resolvedPerformanceKpis],
        KPI_SYNC_RECORD_CONCURRENCY,
        async (record) => {
          // TARGET và ACTUAL nằm ở hai bảng độc lập. Chạy song song hai nhánh vẫn giữ nguyên
          // transaction/audit riêng và cơ chế một nhánh lỗi không làm hỏng nhánh còn lại.
          await Promise.all([
            this.applySafely(run.id, record, 'TARGET', () =>
              this.applyTarget(run.id, actorUserId, period.id, record),
            ),
            this.applySafely(run.id, record, 'ACTUAL', () =>
              this.applyActual(run.id, actorUserId, period.id, record),
            ),
          ]);
        },
      );
      await forEachConcurrent(
        resolvedPerformanceGoals,
        KPI_SYNC_RECORD_CONCURRENCY,
        (record) =>
          this.applyPerformanceGoal(run.id, actorUserId, period.id, record),
      );
      await this.archiveMissingPerformanceGoals(
        team.id,
        period.id,
        performanceOkrs.map((record) => record.external_item_id),
      );
      await this.archiveMissingPerformanceKpis(
        team.id,
        period.id,
        performanceKpis.map((record) => record.external_item_id),
      );

      const counts = await this.countResults(run.id);
      const status = this.resolveRunStatus(counts);
      const sourceWarnings = [
        ...(payload.warnings ?? []),
        ...(performanceGoalPayload.warnings ?? []),
      ];
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.kpiSyncRun.update({
          where: { id: run.id },
          data: {
            status,
            finishedAt: new Date(),
            receivedRecords:
              payload.records.length + performanceGoalPayload.records.length,
            successfulRecords: counts.SUCCESS,
            skippedRecords: counts.SKIPPED,
            conflictRecords: counts.CONFLICT,
            failedRecords: counts.FAILED,
            manualEntryCount: counts.manual,
            warningCount: sourceWarnings.length,
            sourceWarnings: sourceWarnings as unknown as Prisma.InputJsonValue,
          },
          include: this.runInclude,
        });
        await this.auditLog.record(tx, {
          actorUserId,
          action: 'KPI_SYNC_APPLIED',
          entityType: 'KpiSyncRun',
          entityId: run.id,
          payrollPeriodId: period.id,
          afterData: {
            status,
            successfulRecords: counts.SUCCESS,
            skippedRecords: counts.SKIPPED,
            conflictRecords: counts.CONFLICT,
            failedRecords: counts.FAILED,
            warningCount: sourceWarnings.length,
          },
        });
        return updated;
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Lỗi đồng bộ KPI không xác định';
      await this.prisma.$transaction(async (tx) => {
        await tx.kpiSyncRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorSummary: message.slice(0, 1000),
          },
        });
        await this.auditLog.record(tx, {
          actorUserId,
          action: 'KPI_SYNC_FAILED',
          entityType: 'KpiSyncRun',
          entityId: run.id,
          payrollPeriodId: period.id,
          afterData: { status: 'FAILED', error: message.slice(0, 1000) },
        });
      });
      throw error;
    }
  }

  async list(query: PaginationQueryDto, userId: string) {
    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const where = await this.visibleRunsWhere(userId);
    const [runs, total] = await Promise.all([
      this.prisma.kpiSyncRun.findMany({
        where,
        skip,
        take,
        orderBy: { startedAt: 'desc' },
        include: this.runInclude,
      }),
      this.prisma.kpiSyncRun.count({ where }),
    ]);
    return paginate(runs, total, query.page, query.pageSize);
  }

  /** Team nguồn mà user được phép kích hoạt đồng bộ: ALL thấy mọi team, TEAM chỉ team được gán. */
  async listSyncableTeams(userId: string) {
    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'sync.trigger',
    );
    const teamWhere = buildLinkedTeamScopeWhere(scope);
    if (!teamWhere) return [];
    return this.prisma.team.findMany({
      where: { ...teamWhere, status: 'ACTIVE' },
      select: { id: true, code: true, name: true, externalId: true },
      orderBy: { name: 'asc' },
    });
  }

  async get(id: string, userId: string) {
    const where = await this.visibleRunsWhere(userId);
    // Lượt ngoài phạm vi trả 404 như không tồn tại, không tiết lộ dữ liệu team khác.
    const run = await this.prisma.kpiSyncRun.findFirst({
      where: { ...where, id },
      include: {
        ...this.runInclude,
        items: {
          orderBy: [{ resultStatus: 'asc' }, { id: 'asc' }],
          include: {
            employee: {
              select: { id: true, employeeCode: true, fullName: true },
            },
            kpiItem: { select: { id: true, code: true, name: true } },
            employeeOkr: {
              select: { id: true, title: true, goalType: true },
            },
          },
        },
      },
    });
    if (!run) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy lượt đồng bộ KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    return run;
  }

  private readonly runInclude = {
    payrollPeriod: {
      select: { id: true, code: true, name: true, status: true },
    },
    triggeredBy: { select: { id: true, fullName: true } },
  } satisfies Prisma.KpiSyncRunInclude;

  private scopeIncludesTeam(scope: ResolvedScope, teamId: number) {
    return (
      scope.type === 'ALL' ||
      (scope.type === 'TEAM' && scope.teamIds.includes(teamId))
    );
  }

  /** KpiSyncRun chỉ lưu externalTeamId nên phải quy đổi team trong scope sang externalId. */
  private async visibleRunsWhere(
    userId: string,
  ): Promise<Prisma.KpiSyncRunWhereInput> {
    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'sync.view',
    );
    if (scope.type === 'ALL') return {};
    const teamWhere = buildLinkedTeamScopeWhere(scope);
    if (!teamWhere) return { id: { in: [] } };
    const teams = await this.prisma.team.findMany({
      where: teamWhere,
      select: { externalId: true },
    });
    return {
      externalTeamId: {
        in: teams.flatMap((team) => (team.externalId ? [team.externalId] : [])),
      },
    };
  }

  private validatePayload(
    payload: { month?: string; team?: { id?: string }; records?: unknown },
    teamId: string,
    month: string,
  ) {
    if (
      payload.month !== month ||
      payload.team?.id !== teamId ||
      !Array.isArray(payload.records)
    ) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'Dữ liệu KPI từ VCBI không đúng team/tháng hoặc sai định dạng',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private async resolveRecords(
    localTeamId: number,
    externalTeamId: string,
    periodId: number,
    records: AutomationGenVideoKpiRecord[],
  ): Promise<ResolvedRecord[]> {
    const groupCodes = [...new Set(records.map((r) => r.group_code))];

    const [memberships, groups] = await Promise.all([
      this.prisma.employeeTeamMembership.findMany({
        where: { teamId: localTeamId, isActive: true },
        select: {
          employee: {
            select: {
              id: true,
              fullName: true,
              user: { select: { email: true } },
              externalIdentities: {
                where: { sourceSystem: 'AUTOMATION_GEN_VIDEO' },
                select: { externalUserId: true, lastKnownEmail: true },
              },
            },
          },
        },
      }),
      this.prisma.kpiGroup.findMany({
        where: {
          code: { in: groupCodes },
          dataSource: 'AUTOMATION_GEN_VIDEO',
          isActive: true,
        },
        include: { items: { where: { isActive: true } } },
      }),
    ]);
    const employees = memberships.map((membership) => membership.employee);
    // employee_id từ nguồn không tham gia nhận diện. Mapping đã xác nhận được lưu riêng và
    // email/tên chỉ dùng để bootstrap khi chưa có external identity.
    const employeeIdByExternalId = new Map(
      employees.flatMap((employee) =>
        employee.externalIdentities.map(
          (identity) => [identity.externalUserId, employee.id] as const,
        ),
      ),
    );
    const unresolvedUserIds = new Set(
      records
        .filter((record) => !employeeIdByExternalId.has(record.user_id))
        .map((record) => record.user_id),
    );
    const fallbackMatches = new Map<
      string,
      { employeeId?: number; reason?: string }
    >();
    if (unresolvedUserIds.size > 0) {
      try {
        const sourceTeam =
          await this.sourceClient.fetchTeamForPayrollSync(externalTeamId);
        const fallbackMembers = sourceTeam.members.filter((member) =>
          unresolvedUserIds.has(member.user_id),
        );
        const matched = matchEmployeesByEmailOrName(
          // Không cho fallback chiếm một nhân sự đã liên kết với tài khoản nguồn khác.
          employees
            .filter((employee) => employee.externalIdentities.length === 0)
            .map((employee) => ({
              id: employee.id,
              fullName: employee.fullName,
              email: employee.user?.email ?? null,
            })),
          fallbackMembers,
        );
        const sourceMemberById = new Map(
          fallbackMembers.map((member) => [member.user_id, member]),
        );
        for (const userId of unresolvedUserIds) {
          const match = matched.get(userId);
          const sourceMember = sourceMemberById.get(userId);
          if (match?.employeeId != null && sourceMember) {
            // Bootstrap một lần rồi lưu liên kết bền vững. Các lần sync sau đi thẳng bằng
            // external user id, không còn phụ thuộc email/tên có thể thay đổi.
            const identity = await this.prisma.externalEmployeeIdentity.upsert({
              where: {
                sourceSystem_externalUserId: {
                  sourceSystem: SOURCE_SYSTEM,
                  externalUserId: userId,
                },
              },
              update: {
                externalEmployeeCode: sourceMember.employee_id?.trim() || null,
                lastKnownEmail:
                  sourceMember.email?.trim().toLowerCase() || null,
                lastKnownName: sourceMember.full_name,
                lastSyncedAt: new Date(),
              },
              create: {
                employeeId: match.employeeId,
                sourceSystem: SOURCE_SYSTEM,
                externalUserId: userId,
                externalEmployeeCode: sourceMember.employee_id?.trim() || null,
                lastKnownEmail:
                  sourceMember.email?.trim().toLowerCase() || null,
                lastKnownName: sourceMember.full_name,
                lastSyncedAt: new Date(),
              },
              select: { employeeId: true },
            });
            fallbackMatches.set(userId, { employeeId: identity.employeeId });
          } else {
            fallbackMatches.set(
              userId,
              match ?? {
                reason:
                  'Không tìm thấy danh tính user_id trong dữ liệu thành viên của team nguồn',
              },
            );
          }
        }
      } catch {
        // Endpoint KPI vẫn có thể dùng được trong khi endpoint thành viên tạm lỗi. Không làm hỏng
        // các record đã map bằng externalId; chỉ bỏ qua những record thực sự cần fallback.
        for (const userId of unresolvedUserIds) {
          fallbackMatches.set(userId, {
            reason:
              'Không thể tải danh tính thành viên nguồn để fallback theo email hoặc tên',
          });
        }
      }
    }
    const itemByPair = new Map(
      groups.flatMap((g) =>
        g.items.map(
          (i) =>
            [`${g.code}\u0000${i.code}`, { id: i.id, groupId: g.id }] as const,
        ),
      ),
    );
    const employeeIds = employees.map((e) => e.id);
    const groupIds = groups.map((g) => g.id);
    const itemIds = groups.flatMap((group) =>
      group.items.map((item) => item.id),
    );
    const [assignments, existingTargets, existingActuals] = await Promise.all([
      this.prisma.employeeKpiAssignment.findMany({
        where: {
          employeeId: { in: employeeIds },
          kpiGroupId: { in: groupIds },
          payrollPeriodId: periodId,
          teamId: localTeamId,
          assignmentStatus: 'ASSIGNED',
        },
        select: { employeeId: true, kpiGroupId: true },
      }),
      this.prisma.employeeKpiTarget.findMany({
        where: {
          employeeId: { in: employeeIds },
          kpiItemId: { in: itemIds },
          payrollPeriodId: periodId,
          teamId: localTeamId,
        },
        select: {
          id: true,
          employeeId: true,
          kpiItemId: true,
          targetValue: true,
          overrideValue: true,
        },
      }),
      this.prisma.employeeKpiActual.findMany({
        where: {
          employeeId: { in: employeeIds },
          kpiItemId: { in: itemIds },
          payrollPeriodId: periodId,
          teamId: localTeamId,
        },
        select: {
          id: true,
          employeeId: true,
          kpiItemId: true,
          actualValue: true,
          dataSource: true,
          manualEnteredAt: true,
          selfConfirmationStatus: true,
          leaderReviewStatus: true,
        },
      }),
    ]);
    const assigned = new Set(
      assignments.map((a) => `${a.employeeId}:${a.kpiGroupId}`),
    );
    const recordKey = (employeeId: number, kpiItemId: number) =>
      `${employeeId}:${kpiItemId}`;
    const targetByKey = new Map(
      existingTargets.map((target) => [
        recordKey(target.employeeId, target.kpiItemId),
        target,
      ]),
    );
    const actualByKey = new Map(
      existingActuals.map((actual) => [
        recordKey(actual.employeeId, actual.kpiItemId),
        actual,
      ]),
    );

    return records.map((source) => {
      const fallbackMatch = fallbackMatches.get(source.user_id);
      const employeeId =
        employeeIdByExternalId.get(source.user_id) ?? fallbackMatch?.employeeId;
      if (employeeId == null)
        return {
          source,
          teamId: localTeamId,
          reason:
            fallbackMatch?.reason ??
            'Không tìm thấy nhân sự đã đồng bộ có externalId khớp user_id nguồn',
        };
      const item = itemByPair.get(
        `${source.group_code}\u0000${source.metric_code}`,
      );
      if (!item) {
        return {
          source,
          teamId: localTeamId,
          employeeId,
          reason:
            'Không tìm thấy cấu hình group_code + metric_code đang hoạt động',
        };
      }
      if (!assigned.has(`${employeeId}:${item.groupId}`)) {
        return {
          source,
          teamId: localTeamId,
          employeeId,
          kpiItemId: item.id,
          groupId: item.groupId,
          reason: 'Nhân sự chưa được gán nhóm KPI này trong kỳ',
        };
      }
      return {
        source,
        teamId: localTeamId,
        employeeId,
        kpiItemId: item.id,
        groupId: item.groupId,
        previousTarget: targetByKey.get(recordKey(employeeId, item.id)) ?? null,
        previousActual: actualByKey.get(recordKey(employeeId, item.id)) ?? null,
      };
    });
  }

  private async resolvePerformanceGoals(
    localTeamId: number,
    periodId: number,
    records: AutomationGenVideoPerformanceGoalRecord[],
  ): Promise<ResolvedPerformanceGoal[]> {
    const memberships = await this.prisma.employeeTeamMembership.findMany({
      where: { teamId: localTeamId, isActive: true },
      select: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            externalIdentities: {
              where: { sourceSystem: SOURCE_SYSTEM },
              select: { externalUserId: true },
            },
          },
        },
      },
    });
    const employees = memberships.map((membership) => membership.employee);
    const employeeByExternalUserId = new Map(
      employees.flatMap((employee) =>
        employee.externalIdentities.map(
          (identity) => [identity.externalUserId, employee.id] as const,
        ),
      ),
    );
    const employeeByCode = new Map(
      employees.flatMap((employee) => {
        const code = employee.employeeCode?.trim();
        return code ? ([[code, employee.id]] as const) : [];
      }),
    );

    for (const record of records) {
      if (employeeByExternalUserId.has(record.user_id)) continue;
      const employeeId = record.employee_id
        ? employeeByCode.get(record.employee_id.trim())
        : undefined;
      if (employeeId == null) continue;
      const identity = await this.prisma.externalEmployeeIdentity.upsert({
        where: {
          sourceSystem_externalUserId: {
            sourceSystem: SOURCE_SYSTEM,
            externalUserId: record.user_id,
          },
        },
        update: {
          externalEmployeeCode: record.employee_id?.trim() || null,
          lastSyncedAt: new Date(),
        },
        create: {
          employeeId,
          sourceSystem: SOURCE_SYSTEM,
          externalUserId: record.user_id,
          externalEmployeeCode: record.employee_id?.trim() || null,
          lastSyncedAt: new Date(),
        },
        select: { employeeId: true },
      });
      employeeByExternalUserId.set(record.user_id, identity.employeeId);
    }

    const existing = await this.prisma.employeeOkr.findMany({
      where: {
        externalItemId: {
          in: records.map((record) => record.external_item_id),
        },
      },
      select: {
        id: true,
        externalItemId: true,
        targetValue: true,
        actualValue: true,
        rewardAmount: true,
      },
    });
    const existingByExternalId = new Map(
      existing.map((goal) => [goal.externalItemId, goal]),
    );

    return records.map((source) => {
      const employeeId = employeeByExternalUserId.get(source.user_id);
      if (employeeId == null) {
        return {
          source,
          teamId: localTeamId,
          reason:
            'Không tìm thấy nhân sự trong team có user_id hoặc employee_id khớp dữ liệu nguồn',
        };
      }
      const previous =
        existingByExternalId.get(source.external_item_id) ?? null;
      return { source, teamId: localTeamId, employeeId, previous };
    });
  }

  /**
   * Contract 2.0: KPI linh hoạt không còn là "OKR có goalType=KPI". Mỗi record trở thành một
   * KpiItem thuộc đúng group_code nguồn, có target/actual riêng của nhân sự và tham gia toàn bộ
   * luồng KPI chuẩn (xác nhận, duyệt, tiến độ nhóm, mức thưởng nhóm).
   */
  private async resolvePerformanceKpis(
    localTeamId: number,
    periodId: number,
    actorUserId: string,
    records: AutomationGenVideoPerformanceGoalRecord[],
  ): Promise<ResolvedRecord[]> {
    if (records.length === 0) return [];

    const memberships = await this.prisma.employeeTeamMembership.findMany({
      where: { teamId: localTeamId, isActive: true },
      select: {
        employee: {
          select: {
            id: true,
            employeeCode: true,
            externalIdentities: {
              where: { sourceSystem: SOURCE_SYSTEM },
              select: { externalUserId: true },
            },
          },
        },
      },
    });
    const employees = memberships.map((membership) => membership.employee);
    const employeeByExternalUserId = new Map(
      employees.flatMap((employee) =>
        employee.externalIdentities.map(
          (identity) => [identity.externalUserId, employee.id] as const,
        ),
      ),
    );
    const employeeByCode = new Map(
      employees.flatMap((employee) => {
        const code = employee.employeeCode?.trim();
        return code ? ([[code, employee.id]] as const) : [];
      }),
    );

    for (const record of records) {
      if (employeeByExternalUserId.has(record.user_id)) continue;
      const employeeId = record.employee_id
        ? employeeByCode.get(record.employee_id.trim())
        : undefined;
      if (employeeId == null) continue;
      const identity = await this.prisma.externalEmployeeIdentity.upsert({
        where: {
          sourceSystem_externalUserId: {
            sourceSystem: SOURCE_SYSTEM,
            externalUserId: record.user_id,
          },
        },
        update: {
          externalEmployeeCode: record.employee_id?.trim() || null,
          lastSyncedAt: new Date(),
        },
        create: {
          employeeId,
          sourceSystem: SOURCE_SYSTEM,
          externalUserId: record.user_id,
          externalEmployeeCode: record.employee_id?.trim() || null,
          lastSyncedAt: new Date(),
        },
        select: { employeeId: true },
      });
      employeeByExternalUserId.set(record.user_id, identity.employeeId);
    }

    const resolved: ResolvedRecord[] = [];
    for (const sourceGoal of records) {
      const source: AutomationGenVideoKpiRecord = {
        user_id: sourceGoal.user_id,
        employee_id: sourceGoal.employee_id,
        group_code: sourceGoal.kpi_group_code ?? 'UNMAPPED_KPI',
        metric_code: sourceGoal.external_item_id,
        target: sourceGoal.target,
        actual: sourceGoal.actual_final,
      };
      const employeeId = employeeByExternalUserId.get(sourceGoal.user_id);
      if (employeeId == null) {
        resolved.push({
          source,
          teamId: localTeamId,
          reason:
            'Không tìm thấy nhân sự trong team có user_id hoặc employee_id khớp dữ liệu nguồn',
        });
        continue;
      }
      if (!sourceGoal.kpi_group_code || !sourceGoal.kpi_group_name) {
        resolved.push({
          source,
          teamId: localTeamId,
          employeeId,
          reason:
            'KPI nguồn thiếu kpi_group_code/kpi_group_name của contract 2.0',
        });
        continue;
      }

      const group = await this.prisma.kpiGroup.upsert({
        where: { code: sourceGoal.kpi_group_code },
        create: {
          code: sourceGoal.kpi_group_code,
          name: sourceGoal.kpi_group_name,
          description: 'Đồng bộ từ VCBI',
          dataSource: 'AUTOMATION_GEN_VIDEO',
          createdByUserId: actorUserId,
          teams: { create: { teamId: localTeamId } },
        },
        update: {
          name: sourceGoal.kpi_group_name,
          isActive: true,
          // Nhóm đã gắn team này từ lượt sync trước thì bỏ qua, giống `connect` của quan hệ ngầm.
          teams: {
            createMany: {
              data: [{ teamId: localTeamId }],
              skipDuplicates: true,
            },
          },
        },
      });
      const item = await this.prisma.kpiItem.upsert({
        where: { externalItemId: sourceGoal.external_item_id },
        create: {
          kpiGroupId: group.id,
          code: `AGV_${sourceGoal.external_item_id.replace(/-/g, '').toUpperCase()}`,
          name: sourceGoal.title,
          unit: sourceGoal.unit ?? '',
          sortOrder: 1000,
          metricType: sourceGoal.metric_type,
          direction: sourceGoal.direction,
          externalItemId: sourceGoal.external_item_id,
          externalRevision: sourceGoal.revision,
          sourceUpdatedAt: new Date(sourceGoal.updated_at),
          isActive: true,
        },
        update: {
          kpiGroupId: group.id,
          name: sourceGoal.title,
          unit: sourceGoal.unit ?? '',
          metricType: sourceGoal.metric_type,
          direction: sourceGoal.direction,
          externalRevision: sourceGoal.revision,
          sourceUpdatedAt: new Date(sourceGoal.updated_at),
          isActive: true,
        },
      });
      await this.prisma.employeeKpiAssignment.upsert({
        where: {
          employeeId_teamId_kpiGroupId_payrollPeriodId: {
            employeeId,
            teamId: localTeamId,
            kpiGroupId: group.id,
            payrollPeriodId: periodId,
          },
        },
        create: {
          employeeId,
          teamId: localTeamId,
          kpiGroupId: group.id,
          payrollPeriodId: periodId,
          assignedByUserId: actorUserId,
        },
        update: {
          assignmentStatus: 'ASSIGNED',
          assignedByUserId: actorUserId,
          assignedAt: new Date(),
        },
      });
      const [previousTarget, previousActual] = await Promise.all([
        this.prisma.employeeKpiTarget.findUnique({
          where: {
            employeeId_teamId_kpiItemId_payrollPeriodId: {
              employeeId,
              teamId: localTeamId,
              kpiItemId: item.id,
              payrollPeriodId: periodId,
            },
          },
          select: {
            id: true,
            employeeId: true,
            kpiItemId: true,
            targetValue: true,
            overrideValue: true,
          },
        }),
        this.prisma.employeeKpiActual.findUnique({
          where: {
            employeeId_teamId_kpiItemId_payrollPeriodId: {
              employeeId,
              teamId: localTeamId,
              kpiItemId: item.id,
              payrollPeriodId: periodId,
            },
          },
          select: {
            id: true,
            employeeId: true,
            kpiItemId: true,
            actualValue: true,
            dataSource: true,
            manualEnteredAt: true,
            selfConfirmationStatus: true,
            leaderReviewStatus: true,
          },
        }),
      ]);
      resolved.push({
        source,
        teamId: localTeamId,
        employeeId,
        kpiItemId: item.id,
        groupId: group.id,
        previousTarget,
        previousActual,
      });
    }
    return resolved;
  }

  private async applyPerformanceGoal(
    runId: string,
    actorUserId: string,
    periodId: number,
    record: ResolvedPerformanceGoal,
  ) {
    if (record.reason || record.employeeId == null) {
      await Promise.all(
        (['TARGET', 'ACTUAL'] as const).map((kind) =>
          this.prisma.kpiSyncRunItem.create({
            data: {
              ...this.performanceGoalItemCommon(runId, record, kind),
              resultStatus: 'SKIPPED',
              message: record.reason,
            },
          }),
        ),
      );
      return;
    }

    const source = record.source;
    const syncedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const goal = await tx.employeeOkr.upsert({
        where: { externalItemId: source.external_item_id },
        create: {
          employeeId: record.employeeId!,
          payrollPeriodId: periodId,
          teamId: record.teamId,
          goalType: source.item_type,
          title: source.title,
          description: source.description,
          unit: source.unit,
          metricType: source.metric_type,
          direction: source.direction,
          targetValue: source.target,
          actualValue: source.actual_final ?? 0,
          actualMissing: source.actual_final == null,
          rewardAmount: 0,
          dataSource: 'AUTOMATION_GEN_VIDEO',
          externalItemId: source.external_item_id,
          externalRevision: source.revision,
          sourceUpdatedAt: new Date(source.updated_at),
          syncedAt,
          isActive: true,
        },
        update: {
          employeeId: record.employeeId!,
          payrollPeriodId: periodId,
          teamId: record.teamId,
          goalType: source.item_type,
          title: source.title,
          description: source.description,
          unit: source.unit,
          metricType: source.metric_type,
          direction: source.direction,
          targetValue: source.target,
          actualValue: source.actual_final ?? 0,
          actualMissing: source.actual_final == null,
          externalRevision: source.revision,
          sourceUpdatedAt: new Date(source.updated_at),
          syncedAt,
          isActive: true,
        },
      });

      await Promise.all([
        tx.kpiSyncRunItem.create({
          data: {
            ...this.performanceGoalItemCommon(runId, record, 'TARGET'),
            employeeOkrId: goal.id,
            resultStatus: 'SUCCESS',
            previousValue: record.previous?.targetValue,
            incomingValue: source.target,
            appliedValue: source.target,
          },
        }),
        tx.kpiSyncRunItem.create({
          data: {
            ...this.performanceGoalItemCommon(runId, record, 'ACTUAL'),
            employeeOkrId: goal.id,
            resultStatus: source.actual_final == null ? 'SKIPPED' : 'SUCCESS',
            previousValue: record.previous?.actualValue,
            incomingValue: source.actual_final,
            appliedValue: source.actual_final,
            manualEntryRequired: source.actual_final == null,
            message:
              source.actual_final == null
                ? 'VCBI chưa có số thực đạt'
                : undefined,
          },
        }),
      ]);
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'PERFORMANCE_GOAL_SYNCED',
        entityType: 'EmployeeOkr',
        entityId: goal.id,
        targetEmployeeId: record.employeeId,
        payrollPeriodId: periodId,
        beforeData: record.previous
          ? {
              targetValue: record.previous.targetValue.toString(),
              actualValue: record.previous.actualValue.toString(),
              rewardAmount: record.previous.rewardAmount.toString(),
            }
          : undefined,
        afterData: {
          externalItemId: source.external_item_id,
          revision: source.revision,
          goalType: source.item_type,
          targetValue: source.target,
          actualValue: source.actual_final,
        },
      });
    });
  }

  private performanceGoalItemCommon(
    runId: string,
    record: ResolvedPerformanceGoal,
    recordKind: 'TARGET' | 'ACTUAL',
  ) {
    return {
      kpiSyncRunId: runId,
      externalRecordKey: `performance-goal:${record.source.external_item_id}:${recordKind}`,
      externalUserId: this.isUuid(record.source.user_id)
        ? record.source.user_id
        : undefined,
      externalEmployeeCode: record.source.employee_id,
      employeeId: record.employeeId,
      teamId: record.teamId,
      groupCode: record.source.kpi_group_code ?? 'FLEXIBLE_OKR',
      metricCode: record.source.external_item_id,
      recordKind,
    } as const;
  }

  private async archiveMissingPerformanceGoals(
    teamId: number,
    periodId: number,
    incomingExternalIds: string[],
  ) {
    await this.prisma.employeeOkr.updateMany({
      where: {
        teamId,
        payrollPeriodId: periodId,
        goalType: 'OKR',
        dataSource: 'AUTOMATION_GEN_VIDEO',
        isActive: true,
        ...(incomingExternalIds.length > 0
          ? { externalItemId: { notIn: incomingExternalIds } }
          : {}),
      },
      data: { isActive: false, syncedAt: new Date() },
    });
  }

  private async archiveMissingPerformanceKpis(
    teamId: number,
    periodId: number,
    incomingExternalIds: string[],
  ) {
    await this.prisma.kpiItem.updateMany({
      where: {
        externalItemId:
          incomingExternalIds.length > 0
            ? { notIn: incomingExternalIds }
            : { not: null },
        employeeTargets: { some: { teamId, payrollPeriodId: periodId } },
      },
      data: { isActive: false },
    });
  }

  private async applyTarget(
    runId: string,
    actorUserId: string,
    periodId: number,
    record: ResolvedRecord,
  ) {
    const common = this.itemCommon(runId, record, 'TARGET');
    if (record.reason || !record.employeeId || !record.kpiItemId) {
      await this.prisma.kpiSyncRunItem.create({
        data: { ...common, resultStatus: 'SKIPPED', message: record.reason },
      });
      return;
    }
    if (record.source.target == null) {
      const existing = record.previousTarget;
      await this.prisma.kpiSyncRunItem.create({
        data: {
          ...common,
          resultStatus: 'SKIPPED',
          previousValue: existing?.targetValue,
          appliedValue: existing?.overrideValue ?? existing?.targetValue,
          employeeKpiTargetId: existing?.id,
          manualEntryRequired: !existing,
          message: existing
            ? 'Nguồn không có target; giữ giá trị hiện có'
            : 'Nguồn không có target; cần leader nhập tay',
        },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const key = {
        employeeId: record.employeeId!,
        teamId: record.teamId,
        kpiItemId: record.kpiItemId!,
        payrollPeriodId: periodId,
      };
      const previous = record.previousTarget;
      const target = await tx.employeeKpiTarget.upsert({
        where: { employeeId_teamId_kpiItemId_payrollPeriodId: key },
        create: {
          ...key,
          targetValue: record.source.target!,
          dataSource: 'AUTOMATION_GEN_VIDEO',
          syncedAt: new Date(),
          createdByUserId: actorUserId,
        },
        update: {
          targetValue: record.source.target!,
          dataSource: 'AUTOMATION_GEN_VIDEO',
          syncedAt: new Date(),
        },
      });
      await tx.kpiSyncRunItem.create({
        data: {
          ...common,
          resultStatus: 'SUCCESS',
          previousValue: previous?.targetValue,
          incomingValue: record.source.target!,
          appliedValue: target.overrideValue ?? target.targetValue,
          message:
            target.overrideValue != null
              ? 'Đã cập nhật mục tiêu gốc; giữ giá trị mục tiêu điều chỉnh'
              : undefined,
          employeeKpiTargetId: target.id,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_TARGET_SYNCED',
        entityType: 'EmployeeKpiTarget',
        entityId: target.id,
        targetEmployeeId: record.employeeId,
        payrollPeriodId: periodId,
        beforeData: previous
          ? { targetValue: previous.targetValue.toString() }
          : undefined,
        afterData: {
          targetValue: target.targetValue.toString(),
          source: 'AUTOMATION_GEN_VIDEO',
        },
      });
    });
  }

  private async applyActual(
    runId: string,
    actorUserId: string,
    periodId: number,
    record: ResolvedRecord,
  ) {
    const common = this.itemCommon(runId, record, 'ACTUAL');
    if (record.reason || !record.employeeId || !record.kpiItemId) {
      await this.prisma.kpiSyncRunItem.create({
        data: { ...common, resultStatus: 'SKIPPED', message: record.reason },
      });
      return;
    }
    const key = {
      employeeId: record.employeeId,
      teamId: record.teamId,
      kpiItemId: record.kpiItemId,
      payrollPeriodId: periodId,
    };
    const previous = record.previousActual;

    if (record.source.actual == null) {
      const alreadyEntered =
        previous?.dataSource === 'MANUAL' && previous.manualEnteredAt != null;
      let actual = previous;
      if (!actual) {
        actual = await this.prisma.employeeKpiActual.create({
          data: {
            ...key,
            requiresManualEntry: true,
            syncMessage: 'Nguồn không có actual; cần nhập tay',
          },
        });
      } else if (
        !alreadyEntered &&
        actual.selfConfirmationStatus === 'DRAFT' &&
        actual.leaderReviewStatus !== 'APPROVED'
      ) {
        actual = await this.prisma.employeeKpiActual.update({
          where: { id: actual.id },
          data: {
            requiresManualEntry: true,
            syncMessage: 'Nguồn không có actual; cần nhập tay',
          },
        });
      }
      await this.prisma.kpiSyncRunItem.create({
        data: {
          ...common,
          resultStatus: 'SKIPPED',
          previousValue: previous?.actualValue,
          appliedValue: previous?.actualValue,
          employeeKpiActualId: actual?.id,
          manualEntryRequired:
            !alreadyEntered && actual?.selfConfirmationStatus === 'DRAFT',
          message: alreadyEntered
            ? 'Nguồn vẫn thiếu actual; giữ giá trị đã nhập tay'
            : 'Nguồn không có actual; cần nhập tay',
        },
      });
      return;
    }

    if (
      previous &&
      (previous.selfConfirmationStatus === 'CONFIRMED' ||
        previous.leaderReviewStatus === 'APPROVED')
    ) {
      const unchanged = previous.actualValue.equals(record.source.actual);
      await this.prisma.kpiSyncRunItem.create({
        data: {
          ...common,
          resultStatus: unchanged ? 'SUCCESS' : 'CONFLICT',
          previousValue: previous.actualValue,
          incomingValue: record.source.actual,
          appliedValue: previous.actualValue,
          employeeKpiActualId: previous.id,
          hasConflict: !unchanged,
          message: unchanged
            ? 'Giá trị đã khóa trùng với nguồn'
            : 'Actual đã xác nhận/duyệt nên không bị ghi đè',
        },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const actual = await tx.employeeKpiActual.upsert({
        where: { employeeId_teamId_kpiItemId_payrollPeriodId: key },
        create: {
          ...key,
          actualValue: record.source.actual!,
          dataSource: 'AUTOMATION_GEN_VIDEO',
          syncedAt: new Date(),
        },
        update: {
          actualValue: record.source.actual!,
          dataSource: 'AUTOMATION_GEN_VIDEO',
          syncedAt: new Date(),
          requiresManualEntry: false,
          manualEnteredAt: null,
          syncMessage: null,
        },
      });
      await tx.kpiSyncRunItem.create({
        data: {
          ...common,
          resultStatus: 'SUCCESS',
          previousValue: previous?.actualValue,
          incomingValue: record.source.actual!,
          appliedValue: actual.actualValue,
          employeeKpiActualId: actual.id,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_ACTUAL_SYNCED',
        entityType: 'EmployeeKpiActual',
        entityId: actual.id,
        targetEmployeeId: record.employeeId,
        payrollPeriodId: periodId,
        beforeData: previous
          ? { actualValue: previous.actualValue.toString() }
          : undefined,
        afterData: {
          actualValue: actual.actualValue.toString(),
          source: 'AUTOMATION_GEN_VIDEO',
        },
      });
    });
  }

  private itemCommon(
    runId: string,
    record: ResolvedRecord,
    recordKind: 'TARGET' | 'ACTUAL',
  ) {
    return {
      kpiSyncRunId: runId,
      externalRecordKey: `${record.source.user_id}:${record.source.group_code}:${record.source.metric_code}:${recordKind}`,
      externalUserId: this.isUuid(record.source.user_id)
        ? record.source.user_id
        : undefined,
      externalEmployeeCode: record.source.employee_id,
      employeeId: record.employeeId,
      teamId: record.teamId,
      kpiItemId: record.kpiItemId,
      groupCode: record.source.group_code,
      metricCode: record.source.metric_code,
      recordKind,
    } as const;
  }

  /** Một dòng hỏng không làm mất kết quả của các dòng còn lại trong cùng lượt đồng bộ. */
  private async applySafely(
    runId: string,
    record: ResolvedRecord,
    kind: 'TARGET' | 'ACTUAL',
    apply: () => Promise<void>,
  ) {
    try {
      await apply();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Lỗi áp dụng dữ liệu KPI';
      await this.prisma.kpiSyncRunItem.create({
        data: {
          ...this.itemCommon(runId, record, kind),
          resultStatus: 'FAILED',
          incomingValue:
            kind === 'TARGET' ? record.source.target : record.source.actual,
          message: message.slice(0, 1000),
        },
      });
    }
  }

  private async countResults(runId: string) {
    const [grouped, manual] = await Promise.all([
      this.prisma.kpiSyncRunItem.groupBy({
        by: ['resultStatus'],
        where: { kpiSyncRunId: runId },
        _count: true,
      }),
      this.prisma.kpiSyncRunItem.count({
        where: { kpiSyncRunId: runId, manualEntryRequired: true },
      }),
    ]);
    const counts: Record<KpiSyncItemStatus, number> & { manual: number } = {
      SUCCESS: 0,
      SKIPPED: 0,
      FAILED: 0,
      CONFLICT: 0,
      manual,
    };
    grouped.forEach((row) => {
      counts[row.resultStatus] = row._count;
    });
    return counts;
  }

  private resolveRunStatus(counts: Record<KpiSyncItemStatus, number>) {
    if (counts.FAILED > 0 && counts.SUCCESS === 0) return 'FAILED' as const;
    if (counts.SUCCESS === 0 && counts.CONFLICT === 0)
      return 'SKIPPED' as const;
    if (counts.SKIPPED > 0 || counts.CONFLICT > 0 || counts.FAILED > 0)
      return 'PARTIAL' as const;
    return 'SUCCESS' as const;
  }

  private isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
}
