import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { ResolvedScope } from '../../common/types/resolved-scope.types';

/** Empty IN() luôn trả về 0 dòng. */
const NO_MATCH = { id: { in: [] } };

/**
 * Resolves abstract access-control scopes against the employee-team snapshot of a payroll period.
 * Historical access must use the snapshot rather than an employee's current team membership.
 */
@Injectable()
export class PeriodScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async includesEmployee(
    scope: ResolvedScope,
    periodId: number,
    employeeId: number,
    selfEmployeeId: number | null,
  ): Promise<boolean> {
    if (scope.type === 'ALL') return true;
    if (scope.type === 'SELF') return selfEmployeeId === employeeId;
    if (scope.type !== 'TEAM' || scope.teamIds.length === 0) return false;

    if (this.prisma.payrollPeriodEmployeeTeamSnapshot?.findFirst) {
      const snapshot =
        await this.prisma.payrollPeriodEmployeeTeamSnapshot.findFirst({
          where: {
            payrollPeriodId: periodId,
            employeeId,
            teamId: { in: scope.teamIds },
          },
        });
      return Boolean(snapshot);
    }

    const legacySnapshot =
      await this.prisma.payrollPeriodEmployeeSnapshot.findUnique({
        where: {
          payrollPeriodId_employeeId: { payrollPeriodId: periodId, employeeId },
        },
      });
    return Boolean(
      legacySnapshot?.teamIdSnapshot != null &&
      scope.teamIds.includes(legacySnapshot.teamIdSnapshot),
    );
  }

  async resolveEmployeeIds(
    scope: ResolvedScope,
    periodId: number,
    selfEmployeeId: number | null,
  ): Promise<number[] | 'ALL'> {
    if (scope.type === 'ALL') return 'ALL';
    if (scope.type === 'SELF') return selfEmployeeId ? [selfEmployeeId] : [];
    if (scope.type !== 'TEAM' || scope.teamIds.length === 0) return [];

    const snapshots = this.prisma.payrollPeriodEmployeeTeamSnapshot?.findMany
      ? await this.prisma.payrollPeriodEmployeeTeamSnapshot.findMany({
          where: {
            payrollPeriodId: periodId,
            teamId: { in: scope.teamIds },
          },
          select: { employeeId: true },
          distinct: ['employeeId'],
        })
      : await this.prisma.payrollPeriodEmployeeSnapshot.findMany({
          where: {
            payrollPeriodId: periodId,
            teamIdSnapshot: { in: scope.teamIds },
          },
          select: { employeeId: true },
        });
    return snapshots.map(({ employeeId }) => employeeId);
  }

  /**
   * Scope của kỳ dưới dạng điều kiện lọc snapshot (subquery EXISTS trên snapshot team), để nhúng
   * thẳng vào truy vấn danh sách thay vì `resolveEmployeeIds` rồi `IN (...)` — bớt một round-trip.
   */
  snapshotWhere(
    scope: ResolvedScope,
    selfEmployeeId: number | null,
  ): Prisma.PayrollPeriodEmployeeSnapshotWhereInput {
    if (scope.type === 'ALL') return {};
    if (scope.type === 'SELF') {
      return selfEmployeeId ? { employeeId: selfEmployeeId } : NO_MATCH;
    }
    if (scope.type !== 'TEAM' || scope.teamIds.length === 0) return NO_MATCH;
    return { teamSnapshots: { some: { teamId: { in: scope.teamIds } } } };
  }

  /** Như `snapshotWhere`, cho bảng dữ liệu theo kỳ có quan hệ `employee` (KPI assignment, …). */
  employeeWhere(
    scope: ResolvedScope,
    periodId: number,
    selfEmployeeId: number | null,
  ): Prisma.EmployeeWhereInput {
    if (scope.type === 'ALL') return {};
    if (scope.type === 'SELF') {
      return selfEmployeeId ? { id: selfEmployeeId } : NO_MATCH;
    }
    if (scope.type !== 'TEAM' || scope.teamIds.length === 0) return NO_MATCH;
    return {
      periodTeamSnapshots: {
        some: { payrollPeriodId: periodId, teamId: { in: scope.teamIds } },
      },
    };
  }

  async includesEmployeeTeam(
    scope: ResolvedScope,
    periodId: number,
    employeeId: number,
    teamId: number,
    selfEmployeeId: number | null,
  ): Promise<boolean> {
    if (scope.type === 'SELF') return selfEmployeeId === employeeId;
    if (scope.type === 'NONE') return false;
    if (scope.type === 'TEAM' && !scope.teamIds.includes(teamId)) return false;

    if (this.prisma.payrollPeriodEmployeeTeamSnapshot?.count) {
      const count = await this.prisma.payrollPeriodEmployeeTeamSnapshot.count({
        where: { payrollPeriodId: periodId, employeeId, teamId },
      });
      return count > 0;
    }

    const legacySnapshot =
      await this.prisma.payrollPeriodEmployeeSnapshot.findUnique({
        where: {
          payrollPeriodId_employeeId: { payrollPeriodId: periodId, employeeId },
        },
      });
    return Boolean(legacySnapshot?.teamIdSnapshot === teamId);
  }
}
