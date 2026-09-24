import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ResolvedScope } from '../../common/types/resolved-scope.types';

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
