import { Prisma } from '@prisma/client';
import { TeamPerformanceService } from '../team-performance.service';

const decimal = (value: string | number) => new Prisma.Decimal(value);

function makePrisma() {
  const forbiddenWrite = jest.fn();
  return {
    payrollPeriod: {
      findUnique: jest.fn().mockResolvedValue({
        id: 2,
        code: 'LUONG-2026-09',
        name: 'Kỳ lương tháng 09/2026',
        status: 'IN_REVIEW',
        rewardRuleSet: { achievementThresholdPercent: decimal(80) },
      }),
    },
    payrollPeriodEmployeeSnapshot: {
      findMany: jest.fn().mockResolvedValue([
        {
          employeeId: 1,
          employeeCodeSnapshot: 'NV-L01',
          employeeNameSnapshot: 'Trưởng nhóm A',
          jobTitleSnapshot: 'Leader',
          teamIdSnapshot: 10,
          teamCodeSnapshot: 'TEAM-A',
          teamNameSnapshot: 'Team A',
          leaderEmployeeIdSnapshot: 1,
          teamSnapshots: [
            {
              teamId: 10,
              teamCodeSnapshot: 'TEAM-A',
              teamNameSnapshot: 'Team A',
              isPrimary: true,
              leaderEmployeeIdSnapshot: 1,
            },
          ],
          employee: {
            revenueRecords: [],
            trafficRecords: [],
            salaryRecords: [],
            okrs: [],
          },
        },
        {
          employeeId: 2,
          employeeCodeSnapshot: 'NV-001',
          employeeNameSnapshot: 'Nhân sự A',
          jobTitleSnapshot: 'Editor',
          teamIdSnapshot: 10,
          teamCodeSnapshot: 'TEAM-A',
          teamNameSnapshot: 'Team A',
          leaderEmployeeIdSnapshot: 1,
          teamSnapshots: [
            {
              teamId: 10,
              teamCodeSnapshot: 'TEAM-A',
              teamNameSnapshot: 'Team A',
              isPrimary: true,
              leaderEmployeeIdSnapshot: 1,
            },
          ],
          employee: {
            revenueRecords: [{ officialRevenueAmount: decimal(100_000_000) }],
            trafficRecords: [
              {
                views: 1_000n,
                selfConfirmationStatus: 'CONFIRMED',
                leaderReviewStatus: 'APPROVED',
              },
            ],
            salaryRecords: [{ id: 30, status: 'LOCKED' }],
            okrs: [
              {
                teamId: 10,
                direction: 'AT_LEAST',
                targetValue: decimal(10),
                actualValue: decimal(8),
                actualMissing: false,
                overrideValue: null,
                selfConfirmationStatus: 'CONFIRMED',
                leaderReviewStatus: 'APPROVED',
              },
            ],
          },
        },
      ]),
    },
    employeeKpiAssignment: {
      findMany: jest.fn().mockResolvedValue([
        {
          employeeId: 2,
          teamId: 10,
          kpiGroupId: 100,
          kpiGroup: {
            items: [{ id: 501, direction: 'AT_LEAST', externalItemId: null }],
          },
        },
      ]),
    },
    employeeKpiActual: {
      findMany: jest.fn().mockResolvedValue([
        {
          employeeId: 2,
          teamId: 10,
          kpiItemId: 501,
          actualValue: decimal(9),
          overrideValue: null,
          requiresManualEntry: false,
          manualEnteredAt: null,
          selfConfirmationStatus: 'CONFIRMED',
          leaderReviewStatus: 'APPROVED',
        },
      ]),
    },
    employeeKpiTarget: { findMany: jest.fn().mockResolvedValue([]) },
    kpiPeriodTarget: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ kpiItemId: 501, targetValue: decimal(10) }]),
    },
    salaryRecord: { create: forbiddenWrite },
    salaryRecordComponent: { create: forbiddenWrite },
    forbiddenWrite,
  };
}

function makeAuthorization(scope = { type: 'TEAM', teamIds: [10] }) {
  return {
    resolvePermissionScope: jest.fn().mockResolvedValue(scope),
  };
}

describe('TeamPerformanceService', () => {
  it('excludes the Leader and aggregates approved team performance without creating a bonus', async () => {
    const prisma = makePrisma();
    const service = new TeamPerformanceService(
      prisma as never,
      makeAuthorization() as never,
    );

    const result = await service.getPerformance('leader-user', 2);

    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      employeeId: 2,
      employeeName: 'Nhân sự A',
      revenueAmount: '100000000',
      traffic: { acceptedViews: '1000', ready: true },
      salary: { id: 30, status: 'LOCKED' },
      kpi: {
        totalCount: 1,
        achievedCount: 1,
        averageProgressPercent: 90,
      },
      okr: {
        totalCount: 1,
        achievedCount: 1,
        averageProgressPercent: 80,
      },
    });
    expect(result.summary).toMatchObject({
      memberCount: 1,
      revenue: { readyCount: 1, totalAmount: '100000000' },
      traffic: { readyCount: 1, acceptedViews: '1000' },
      salary: { lockedCount: 1 },
      achievementCount: 2,
      notAchievedCount: 0,
    });
    expect(result.teams).toEqual([
      expect.objectContaining({ id: 10, name: 'Team A', memberCount: 1 }),
    ]);
    expect(prisma.forbiddenWrite).not.toHaveBeenCalled();
  });

  it('rejects a team outside the Leader scope before reading snapshots', async () => {
    const prisma = makePrisma();
    const service = new TeamPerformanceService(
      prisma as never,
      makeAuthorization() as never,
    );

    await expect(
      service.getPerformance('leader-user', 2, 20),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    expect(
      prisma.payrollPeriodEmployeeSnapshot.findMany,
    ).not.toHaveBeenCalled();
  });

  it('does not grant team performance to a SELF-only employee', async () => {
    const prisma = makePrisma();
    const service = new TeamPerformanceService(
      prisma as never,
      makeAuthorization({ type: 'SELF' } as never) as never,
    );

    await expect(
      service.getPerformance('editor-user', 2),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      prisma.payrollPeriodEmployeeSnapshot.findMany,
    ).not.toHaveBeenCalled();
  });
});
