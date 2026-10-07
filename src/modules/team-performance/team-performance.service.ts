import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  type SalaryRecordStatus,
  type SelfConfirmationStatus,
  type LeaderReviewStatus,
} from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { ResolvedScope } from '../../common/types/resolved-scope.types';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../access-control/authorization.service';
import { PeriodScopeService } from '../access-control/period-scope.service';
import {
  calculatePerformanceGoalProgressPercent,
  calculateProgressPercent,
} from '../salary/salary-calculator';

const VIEW_PERMISSIONS = {
  employee: ['employee.view_team', 'employee.view_all'],
  kpi: ['kpi.view_team', 'kpi.view_all'],
  okr: ['okr.view_team', 'okr.view_all'],
  revenue: ['revenue.view_team', 'revenue.view_all'],
  traffic: ['traffic.view_team', 'traffic.view_all'],
  salary: ['salary.view_team', 'salary.view_all'],
} as const;

type TeamMembership = {
  teamId: number;
  teamCode: string;
  teamName: string;
  isPrimary: boolean;
  leaderEmployeeId: number | null;
};

type MetricStatus = 'ACHIEVED' | 'NOT_ACHIEVED' | 'PENDING';

type GoalSummary = {
  totalCount: number;
  achievedCount: number;
  notAchievedCount: number;
  pendingCount: number;
  averageProgressPercent: number | null;
};

@Injectable()
export class TeamPerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly periodScope: PeriodScopeService = new PeriodScopeService(
      prisma,
    ),
  ) {}

  async getPerformance(
    actorUserId: string,
    periodId: number,
    requestedTeamId?: number,
  ) {
    const [period, scopes] = await Promise.all([
      this.prisma.payrollPeriod.findUnique({
        where: { id: periodId },
        select: {
          id: true,
          code: true,
          name: true,
          status: true,
          rewardRuleSet: {
            select: { achievementThresholdPercent: true },
          },
        },
      }),
      this.resolveScopes(actorUserId),
    ]);
    if (!period) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy kỳ lương',
        HttpStatus.NOT_FOUND,
      );
    }
    if (scopes.employee.type === 'NONE' || scopes.employee.type === 'SELF') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Bạn không có quyền xem hiệu suất team',
        HttpStatus.FORBIDDEN,
      );
    }
    if (
      requestedTeamId !== undefined &&
      scopes.employee.type === 'TEAM' &&
      !scopes.employee.teamIds.includes(requestedTeamId)
    ) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Team này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    const snapshots = await this.prisma.payrollPeriodEmployeeSnapshot.findMany({
      where: {
        payrollPeriodId: periodId,
        AND: [this.periodScope.snapshotWhere(scopes.employee, null)],
      },
      orderBy: { employeeNameSnapshot: 'asc' },
      select: {
        employeeId: true,
        employeeCodeSnapshot: true,
        employeeNameSnapshot: true,
        jobTitleSnapshot: true,
        teamIdSnapshot: true,
        teamCodeSnapshot: true,
        teamNameSnapshot: true,
        leaderEmployeeIdSnapshot: true,
        teamSnapshots: {
          select: {
            teamId: true,
            teamCodeSnapshot: true,
            teamNameSnapshot: true,
            isPrimary: true,
            leaderEmployeeIdSnapshot: true,
          },
        },
        employee: {
          select: {
            revenueRecords: {
              where: { payrollPeriodId: periodId },
              take: 1,
              select: { officialRevenueAmount: true },
            },
            trafficRecords: {
              where: { payrollPeriodId: periodId },
              select: {
                views: true,
                selfConfirmationStatus: true,
                leaderReviewStatus: true,
              },
            },
            salaryRecords: {
              where: { payrollPeriodId: periodId },
              orderBy: { versionNumber: 'desc' },
              take: 1,
              select: { id: true, status: true },
            },
            okrs: {
              where: {
                payrollPeriodId: periodId,
                goalType: 'OKR',
                isActive: true,
              },
              select: {
                teamId: true,
                direction: true,
                targetValue: true,
                actualValue: true,
                actualMissing: true,
                overrideValue: true,
                selfConfirmationStatus: true,
                leaderReviewStatus: true,
              },
            },
          },
        },
      },
    });

    const prepared = snapshots.map((snapshot) => ({
      snapshot,
      memberships: this.snapshotMemberships(snapshot, scopes.employee),
      knownMemberships: this.snapshotMemberships(
        snapshot,
        scopes.employee,
        false,
      ),
    }));
    const knownTeams = collectTeams(
      prepared.map(({ knownMemberships }) => ({
        memberships: knownMemberships,
      })),
    );
    if (requestedTeamId !== undefined && !knownTeams.has(requestedTeamId)) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy team trong snapshot của kỳ lương',
        HttpStatus.NOT_FOUND,
      );
    }

    const selected = prepared
      .map(({ snapshot, memberships }) => ({
        snapshot,
        memberships:
          requestedTeamId === undefined
            ? memberships
            : memberships.filter(
                (membership) => membership.teamId === requestedTeamId,
              ),
      }))
      .filter(({ memberships }) => memberships.length > 0);
    const kpiByEmployee = await this.loadKpiSummaries(
      periodId,
      selected,
      scopes.kpi,
      period.rewardRuleSet?.achievementThresholdPercent ?? null,
      requestedTeamId,
    );

    const members = selected.map(({ snapshot, memberships }) => {
      const primaryMembership =
        memberships.find((membership) => membership.isPrimary) ??
        memberships[0];
      const visibility = {
        kpi: isVisibleInMemberships(scopes.kpi, memberships),
        okr: isVisibleInMemberships(scopes.okr, memberships),
        revenue: isVisibleInMemberships(scopes.revenue, memberships),
        traffic: isVisibleInMemberships(scopes.traffic, memberships),
        salary: isVisibleInMemberships(scopes.salary, memberships),
      };
      const revenueRecord = visibility.revenue
        ? (snapshot.employee.revenueRecords[0] ?? null)
        : null;
      const trafficRecords = visibility.traffic
        ? snapshot.employee.trafficRecords
        : [];
      const acceptedTraffic = trafficRecords.filter(isAcceptedTraffic);
      const pendingPlatforms = trafficRecords.filter(
        (record) =>
          record.selfConfirmationStatus !== 'CONFIRMED' ||
          record.leaderReviewStatus === 'PENDING',
      ).length;
      const rejectedPlatforms = trafficRecords.filter(
        (record) => record.leaderReviewStatus === 'REJECTED',
      ).length;
      const traffic = visibility.traffic
        ? {
            acceptedViews: sumViews(acceptedTraffic).toString(),
            completedPlatforms: trafficRecords.length,
            approvedPlatforms: acceptedTraffic.length,
            pendingPlatforms,
            rejectedPlatforms,
            ready:
              trafficRecords.length > 0 &&
              pendingPlatforms === 0 &&
              rejectedPlatforms === 0,
          }
        : null;
      const salaryRecord = visibility.salary
        ? (snapshot.employee.salaryRecords[0] ?? null)
        : null;
      const kpi = visibility.kpi
        ? (kpiByEmployee.get(snapshot.employeeId) ?? emptyGoalSummary())
        : null;
      const okr = visibility.okr
        ? summarizeOkrs(
            snapshot.employee.okrs.filter(
              (goal) =>
                (goal.teamId === null ||
                  scopes.okr.type === 'ALL' ||
                  (scopes.okr.type === 'TEAM' &&
                    scopes.okr.teamIds.includes(goal.teamId))) &&
                (requestedTeamId === undefined ||
                  goal.teamId === null ||
                  goal.teamId === requestedTeamId),
            ),
            period.rewardRuleSet?.achievementThresholdPercent ?? null,
          )
        : null;

      return {
        employeeId: snapshot.employeeId,
        employeeCode: snapshot.employeeCodeSnapshot,
        employeeName: snapshot.employeeNameSnapshot,
        jobTitle: snapshot.jobTitleSnapshot,
        teamId: primaryMembership.teamId,
        teamName: primaryMembership.teamName,
        teams: memberships.map((membership) => ({
          id: membership.teamId,
          code: membership.teamCode,
          name: membership.teamName,
          isPrimary: membership.isPrimary,
        })),
        visibility,
        revenueAmount: revenueRecord?.officialRevenueAmount.toFixed(0) ?? null,
        traffic,
        salary: salaryRecord
          ? { id: salaryRecord.id, status: salaryRecord.status }
          : null,
        kpi,
        okr,
        isComplete:
          (!visibility.revenue || revenueRecord !== null) &&
          (!visibility.traffic || traffic?.ready === true) &&
          (!visibility.salary || salaryRecord?.status === 'LOCKED'),
      };
    });

    const summary = summarizeMembers(members);
    const teams = [...knownTeams.values()]
      .map((team) => ({
        ...team,
        memberCount: new Set(
          prepared
            .filter(({ memberships }) =>
              memberships.some((membership) => membership.teamId === team.id),
            )
            .map(({ snapshot }) => snapshot.employeeId),
        ).size,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, 'vi'));

    return {
      period: {
        id: period.id,
        code: period.code,
        name: period.name,
        status: period.status,
      },
      scope: scopes.employee.type,
      selectedTeamId: requestedTeamId ?? null,
      achievementThresholdPercent:
        period.rewardRuleSet?.achievementThresholdPercent.toString() ?? null,
      capabilities: {
        kpi: members.some((member) => member.visibility.kpi),
        okr: members.some((member) => member.visibility.okr),
        revenue: members.some((member) => member.visibility.revenue),
        traffic: members.some((member) => member.visibility.traffic),
        salary: members.some((member) => member.visibility.salary),
      },
      teams,
      summary,
      members,
    };
  }

  private async resolveScopes(actorUserId: string) {
    const [employee, kpi, okr, revenue, traffic, salary] = await Promise.all(
      Object.values(VIEW_PERMISSIONS).map((permissions) =>
        this.authorization.resolvePermissionScope(actorUserId, permissions),
      ),
    );
    return { employee, kpi, okr, revenue, traffic, salary };
  }

  private snapshotMemberships(
    snapshot: {
      employeeId: number;
      teamIdSnapshot: number | null;
      teamCodeSnapshot: string | null;
      teamNameSnapshot: string | null;
      leaderEmployeeIdSnapshot: number | null;
      teamSnapshots: Array<{
        teamId: number;
        teamCodeSnapshot: string;
        teamNameSnapshot: string;
        isPrimary: boolean;
        leaderEmployeeIdSnapshot: number | null;
      }>;
    },
    scope: ResolvedScope,
    excludeLeader = true,
  ): TeamMembership[] {
    const memberships = snapshot.teamSnapshots.length
      ? snapshot.teamSnapshots.map((membership) => ({
          teamId: membership.teamId,
          teamCode: membership.teamCodeSnapshot,
          teamName: membership.teamNameSnapshot,
          isPrimary: membership.isPrimary,
          leaderEmployeeId: membership.leaderEmployeeIdSnapshot,
        }))
      : snapshot.teamIdSnapshot !== null
        ? [
            {
              teamId: snapshot.teamIdSnapshot,
              teamCode: snapshot.teamCodeSnapshot ?? '',
              teamName: snapshot.teamNameSnapshot ?? 'Team chưa đặt tên',
              isPrimary: true,
              leaderEmployeeId: snapshot.leaderEmployeeIdSnapshot,
            },
          ]
        : [];

    return memberships.filter(
      (membership) =>
        (!excludeLeader ||
          membership.leaderEmployeeId !== snapshot.employeeId) &&
        (scope.type === 'ALL' ||
          (scope.type === 'TEAM' && scope.teamIds.includes(membership.teamId))),
    );
  }

  private async loadKpiSummaries(
    periodId: number,
    members: Array<{
      snapshot: { employeeId: number };
      memberships: TeamMembership[];
    }>,
    scope: ResolvedScope,
    threshold: Prisma.Decimal | null,
    requestedTeamId?: number,
  ): Promise<Map<number, GoalSummary>> {
    const eligible = members.filter(({ memberships }) =>
      isVisibleInMemberships(scope, memberships),
    );
    const employeeIds = eligible.map(({ snapshot }) => snapshot.employeeId);
    const teamIds = [
      ...new Set(
        eligible.flatMap(({ memberships }) =>
          memberships
            .filter(
              (membership) =>
                (scope.type === 'ALL' ||
                  (scope.type === 'TEAM' &&
                    scope.teamIds.includes(membership.teamId))) &&
                (requestedTeamId === undefined ||
                  membership.teamId === requestedTeamId),
            )
            .map((membership) => membership.teamId),
        ),
      ),
    ];
    if (employeeIds.length === 0 || teamIds.length === 0) {
      return new Map<number, GoalSummary>();
    }

    const assignments = await this.prisma.employeeKpiAssignment.findMany({
      where: {
        payrollPeriodId: periodId,
        employeeId: { in: employeeIds },
        teamId: { in: teamIds },
        assignmentStatus: 'ASSIGNED',
      },
      select: {
        employeeId: true,
        teamId: true,
        kpiGroupId: true,
        kpiGroup: {
          select: {
            items: {
              where: { isActive: true },
              select: { id: true, direction: true, externalItemId: true },
            },
          },
        },
      },
    });
    const membershipPairs = new Set(
      eligible.flatMap(({ snapshot, memberships }) =>
        memberships
          .filter(
            (membership) =>
              scope.type === 'ALL' ||
              (scope.type === 'TEAM' &&
                scope.teamIds.includes(membership.teamId)),
          )
          .map((membership) => `${snapshot.employeeId}:${membership.teamId}`),
      ),
    );
    const visibleAssignments = assignments.filter((assignment) =>
      membershipPairs.has(`${assignment.employeeId}:${assignment.teamId}`),
    );
    const itemIds = [
      ...new Set(
        visibleAssignments.flatMap((assignment) =>
          assignment.kpiGroup.items.map((item) => item.id),
        ),
      ),
    ];
    if (itemIds.length === 0) {
      return new Map(
        employeeIds.map((employeeId) => [employeeId, emptyGoalSummary()]),
      );
    }

    const [actuals, employeeTargets, periodTargets] = await Promise.all([
      this.prisma.employeeKpiActual.findMany({
        where: {
          payrollPeriodId: periodId,
          employeeId: { in: employeeIds },
          teamId: { in: teamIds },
          kpiItemId: { in: itemIds },
        },
        select: {
          employeeId: true,
          teamId: true,
          kpiItemId: true,
          actualValue: true,
          overrideValue: true,
          requiresManualEntry: true,
          manualEnteredAt: true,
          selfConfirmationStatus: true,
          leaderReviewStatus: true,
        },
      }),
      this.prisma.employeeKpiTarget.findMany({
        where: {
          payrollPeriodId: periodId,
          employeeId: { in: employeeIds },
          teamId: { in: teamIds },
          kpiItemId: { in: itemIds },
        },
        select: {
          employeeId: true,
          teamId: true,
          kpiItemId: true,
          targetValue: true,
          overrideValue: true,
        },
      }),
      this.prisma.kpiPeriodTarget.findMany({
        where: { payrollPeriodId: periodId, kpiItemId: { in: itemIds } },
        select: { kpiItemId: true, targetValue: true },
      }),
    ]);
    const key = (employeeId: number, teamId: number, itemId: number) =>
      `${employeeId}:${teamId}:${itemId}`;
    const actualByKey = new Map(
      actuals.map((actual) => [
        key(actual.employeeId, actual.teamId, actual.kpiItemId),
        actual,
      ]),
    );
    const employeeTargetByKey = new Map(
      employeeTargets.map((target) => [
        key(target.employeeId, target.teamId, target.kpiItemId),
        target,
      ]),
    );
    const periodTargetByItem = new Map(
      periodTargets.map((target) => [target.kpiItemId, target.targetValue]),
    );
    const groupsByEmployee = new Map<
      number,
      Array<{ progress: number | null; status: MetricStatus }>
    >();

    for (const assignment of visibleAssignments) {
      const items = assignment.kpiGroup.items
        .map((item) => {
          const itemKey = key(
            assignment.employeeId,
            assignment.teamId,
            item.id,
          );
          const employeeTarget = employeeTargetByKey.get(itemKey);
          if (item.externalItemId !== null && !employeeTarget) return null;
          const target =
            employeeTarget?.overrideValue ??
            employeeTarget?.targetValue ??
            periodTargetByItem.get(item.id) ??
            null;
          const actual = actualByKey.get(itemKey);
          const actualMissing =
            !actual ||
            (actual.requiresManualEntry && actual.manualEnteredAt === null);
          return { item, target, actual, actualMissing };
        })
        .filter(
          (
            item,
          ): item is NonNullable<typeof item> & { target: Prisma.Decimal } =>
            item !== null && item.target !== null,
        );
      const progress =
        items.length > 0
          ? calculateProgressPercent(
              items.map(({ item, target, actual }) => ({
                actual:
                  actual?.overrideValue ??
                  actual?.actualValue ??
                  new Prisma.Decimal(0),
                target,
                direction: item.direction,
              })),
            ).toNumber()
          : null;
      const approved =
        items.length > 0 &&
        items.every(
          ({ actual, actualMissing }) =>
            !actualMissing &&
            actual?.selfConfirmationStatus === 'CONFIRMED' &&
            actual.leaderReviewStatus === 'APPROVED',
        );
      const status = metricStatus(progress, approved, threshold);
      const employeeGroups = groupsByEmployee.get(assignment.employeeId) ?? [];
      employeeGroups.push({ progress, status });
      groupsByEmployee.set(assignment.employeeId, employeeGroups);
    }

    return new Map(
      employeeIds.map((employeeId) => [
        employeeId,
        summarizeGoals(groupsByEmployee.get(employeeId) ?? []),
      ]),
    );
  }
}

function collectTeams(
  prepared: Array<{
    memberships: TeamMembership[];
  }>,
) {
  return new Map(
    prepared.flatMap(({ memberships }) =>
      memberships.map(
        (membership) =>
          [
            membership.teamId,
            {
              id: membership.teamId,
              code: membership.teamCode,
              name: membership.teamName,
            },
          ] as const,
      ),
    ),
  );
}

function isVisibleInMemberships(
  scope: ResolvedScope,
  memberships: TeamMembership[],
) {
  if (scope.type === 'ALL') return true;
  if (scope.type !== 'TEAM') return false;
  return memberships.some((membership) =>
    scope.teamIds.includes(membership.teamId),
  );
}

function isAcceptedTraffic(record: {
  selfConfirmationStatus: SelfConfirmationStatus;
  leaderReviewStatus: LeaderReviewStatus;
}) {
  return (
    record.selfConfirmationStatus === 'CONFIRMED' &&
    record.leaderReviewStatus === 'APPROVED'
  );
}

function sumViews(records: Array<{ views: bigint }>) {
  return records.reduce((total, record) => total + record.views, 0n);
}

function summarizeOkrs(
  okrs: Array<{
    direction: 'AT_LEAST' | 'AT_MOST';
    targetValue: Prisma.Decimal;
    actualValue: Prisma.Decimal;
    actualMissing: boolean;
    overrideValue: Prisma.Decimal | null;
    selfConfirmationStatus: SelfConfirmationStatus;
    leaderReviewStatus: LeaderReviewStatus;
  }>,
  threshold: Prisma.Decimal | null,
) {
  return summarizeGoals(
    okrs.map((okr) => {
      const progress = okr.actualMissing
        ? null
        : calculatePerformanceGoalProgressPercent(
            okr.overrideValue ?? okr.actualValue,
            okr.targetValue,
            okr.direction,
          ).toNumber();
      const approved =
        !okr.actualMissing &&
        okr.selfConfirmationStatus === 'CONFIRMED' &&
        okr.leaderReviewStatus === 'APPROVED';
      return {
        progress,
        status: metricStatus(progress, approved, threshold),
      };
    }),
  );
}

function metricStatus(
  progress: number | null,
  approved: boolean,
  threshold: Prisma.Decimal | null,
): MetricStatus {
  if (!approved || progress === null || threshold === null) return 'PENDING';
  return progress >= threshold.toNumber() ? 'ACHIEVED' : 'NOT_ACHIEVED';
}

function summarizeGoals(
  goals: Array<{ progress: number | null; status: MetricStatus }>,
): GoalSummary {
  const progressValues = goals
    .map((goal) => goal.progress)
    .filter((progress): progress is number => progress !== null);
  return {
    totalCount: goals.length,
    achievedCount: goals.filter((goal) => goal.status === 'ACHIEVED').length,
    notAchievedCount: goals.filter((goal) => goal.status === 'NOT_ACHIEVED')
      .length,
    pendingCount: goals.filter((goal) => goal.status === 'PENDING').length,
    averageProgressPercent:
      progressValues.length > 0
        ? roundPercent(
            progressValues.reduce((total, value) => total + value, 0) /
              progressValues.length,
          )
        : null,
  };
}

function emptyGoalSummary(): GoalSummary {
  return summarizeGoals([]);
}

function summarizeMembers(
  members: Array<{
    visibility: {
      kpi: boolean;
      okr: boolean;
      revenue: boolean;
      traffic: boolean;
      salary: boolean;
    };
    revenueAmount: string | null;
    traffic: { acceptedViews: string; ready: boolean } | null;
    salary: { status: SalaryRecordStatus } | null;
    kpi: GoalSummary | null;
    okr: GoalSummary | null;
  }>,
) {
  const revenueMembers = members.filter((member) => member.visibility.revenue);
  const trafficMembers = members.filter((member) => member.visibility.traffic);
  const salaryMembers = members.filter((member) => member.visibility.salary);
  const kpi = combineGoalSummaries(
    members.map((member) => member.kpi).filter(isGoalSummary),
  );
  const okr = combineGoalSummaries(
    members.map((member) => member.okr).filter(isGoalSummary),
  );
  return {
    memberCount: members.length,
    revenue: {
      eligibleMemberCount: revenueMembers.length,
      readyCount: revenueMembers.filter(
        (member) => member.revenueAmount !== null,
      ).length,
      totalAmount: revenueMembers
        .reduce(
          (total, member) =>
            total + BigInt(member.revenueAmount?.split('.')[0] ?? '0'),
          0n,
        )
        .toString(),
    },
    traffic: {
      eligibleMemberCount: trafficMembers.length,
      readyCount: trafficMembers.filter(
        (member) => member.traffic?.ready === true,
      ).length,
      acceptedViews: trafficMembers
        .reduce(
          (total, member) =>
            total + BigInt(member.traffic?.acceptedViews ?? '0'),
          0n,
        )
        .toString(),
    },
    salary: {
      eligibleMemberCount: salaryMembers.length,
      lockedCount: salaryMembers.filter(
        (member) => member.salary?.status === 'LOCKED',
      ).length,
    },
    kpi,
    okr,
    achievementCount: kpi.achievedCount + okr.achievedCount,
    notAchievedCount: kpi.notAchievedCount + okr.notAchievedCount,
  };
}

function isGoalSummary(summary: GoalSummary | null): summary is GoalSummary {
  return summary !== null;
}

function combineGoalSummaries(summaries: GoalSummary[]): GoalSummary {
  const totalCount = summaries.reduce(
    (total, summary) => total + summary.totalCount,
    0,
  );
  const memberAverages = summaries
    .map((summary) => summary.averageProgressPercent)
    .filter((value): value is number => value !== null);
  return {
    totalCount,
    achievedCount: summaries.reduce(
      (total, summary) => total + summary.achievedCount,
      0,
    ),
    notAchievedCount: summaries.reduce(
      (total, summary) => total + summary.notAchievedCount,
      0,
    ),
    pendingCount: summaries.reduce(
      (total, summary) => total + summary.pendingCount,
      0,
    ),
    averageProgressPercent:
      memberAverages.length > 0
        ? roundPercent(
            memberAverages.reduce((total, value) => total + value, 0) /
              memberAverages.length,
          )
        : null,
  };
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}
