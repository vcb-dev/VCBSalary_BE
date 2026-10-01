/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Prisma } from '@prisma/client';
import { SalaryCalculationMode } from '../dto/salary.dto';
import { SalaryService } from '../salary.service';

const decimal = (value: string | number) => new Prisma.Decimal(value);

function groupAssignment(
  id: number,
  name: string,
  actualValue: number,
  targetValue: number,
  teamId = 10,
  teamName = 'Team A',
) {
  return {
    id,
    teamId,
    team: { id: teamId, name: teamName },
    kpiGroup: {
      id,
      name,
      items: [
        {
          id,
          name: `${name} item`,
          periodTargets: [{ targetValue: decimal(targetValue) }],
          employeeTargets: [],
          employeeActuals: [
            {
              teamId,
              actualValue: decimal(actualValue),
              overrideValue: null,
              leaderReviewStatus: 'APPROVED',
            },
          ],
        },
      ],
    },
  };
}

function makePrismaMock() {
  return {
    payrollPeriod: {
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue({
        id: 2,
        status: 'OPEN',
        endDate: new Date('2026-09-30'),
        rewardRuleSet: {
          id: 3,
          version: 1,
          achievementThresholdPercent: decimal(80),
          revenueBrackets: [
            {
              id: 4,
              label: '500-700 triệu',
              minRevenueAmount: decimal(500_000_000),
              maxRevenueAmount: decimal(700_000_000),
              commissionRatePercent: decimal('0.6'),
              rpmRatePer1000Views: decimal(120),
            },
            {
              id: 5,
              label: '100-300 triệu',
              minRevenueAmount: decimal(100_000_000),
              maxRevenueAmount: decimal(300_000_000),
              commissionRatePercent: decimal('0.4'),
              rpmRatePer1000Views: decimal(80),
            },
          ],
        },
      }),
    },
    payrollPeriodEmployeeSnapshot: {
      findUnique: jest.fn().mockResolvedValue({
        employeeId: 1,
        payrollPeriodId: 2,
        employeeCodeSnapshot: 'NV001',
        employeeNameSnapshot: 'Nhân sự A',
        jobTitleSnapshot: 'Editor',
        teamIdSnapshot: 10,
        teamNameSnapshot: 'Team A',
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    team: { findMany: jest.fn().mockResolvedValue([]) },
    baseSalaryHistory: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ monthlyBaseSalary: decimal(18_000_000) }),
    },
    employeeKpiAssignment: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          groupAssignment(11, 'KPI A', 10, 10),
          groupAssignment(12, 'KPI B', 8, 10),
        ]),
    },
    employeeKpiRewardRate: {
      findMany: jest.fn().mockResolvedValue([
        { kpiGroupId: 11, rewardAmount: decimal(2_000_000) },
        { kpiGroupId: 12, rewardAmount: decimal(1_500_000) },
      ]),
    },
    employeeOkr: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 21,
          title: 'OKR A',
          targetValue: decimal(10),
          actualValue: decimal(8),
          rewardAmount: decimal(1_000_000),
          selfConfirmationStatus: 'CONFIRMED',
          leaderReviewStatus: 'APPROVED',
        },
      ]),
    },
    employeeTrafficRecord: {
      findMany: jest.fn().mockResolvedValue([
        {
          views: 56_250_000n,
          selfConfirmationStatus: 'CONFIRMED',
          leaderReviewStatus: 'APPROVED',
        },
      ]),
    },
    employeeRevenueRecord: {
      findUnique: jest.fn().mockResolvedValue({
        officialRevenueAmount: decimal(500_000_000),
      }),
    },
    kpiSyncRunItem: { findMany: jest.fn().mockResolvedValue([]) },
    salaryRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest
      .fn()
      .mockImplementation((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
  };
}

function makeService(prisma: ReturnType<typeof makePrismaMock>) {
  const authorization = {
    resolveScope: jest.fn().mockResolvedValue({ type: 'ALL' }),
    resolvePermissionScope: jest.fn().mockResolvedValue({ type: 'ALL' }),
    getEmployeeId: jest.fn(),
  };
  return new SalaryService(
    prisma as never,
    authorization as never,
    { record: jest.fn(), notify: jest.fn() } as never,
  );
}

describe('SalaryService preview', () => {
  it('uses the leader adjusted OKR actual when calculating reward', async () => {
    const prisma = makePrismaMock();
    prisma.employeeOkr.findMany.mockResolvedValue([
      {
        id: 21,
        title: 'OKR A',
        targetValue: decimal(10),
        actualValue: decimal(8),
        overrideValue: decimal(2),
        rewardAmount: decimal(1_000_000),
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'APPROVED',
      },
    ]);

    const result = await makeService(prisma).calculateEmployee(
      'admin',
      2,
      1,
      SalaryCalculationMode.PREVIEW,
    );

    expect(result.okrRewardAmount).toBe('0');
  });

  it('calculates the complete regression case A', async () => {
    const prisma = makePrismaMock();
    const result = await makeService(prisma).calculateEmployee(
      'admin',
      2,
      1,
      SalaryCalculationMode.PREVIEW,
    );

    expect(result).toMatchObject({
      baseSalaryAmount: '18000000',
      kpiRewardAmount: '3500000',
      okrRewardAmount: '1000000',
      commissionAmount: '3000000',
      rpmRewardAmount: '6750000',
      totalSalaryAmount: '32250000',
      status: 'PENDING',
      warnings: [],
    });
    expect(prisma.baseSalaryHistory.findFirst).toHaveBeenCalledWith({
      where: {
        employeeId: 1,
        effectiveFrom: { lte: new Date('2026-09-30') },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gte: new Date('2026-09-30') } },
        ],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: { monthlyBaseSalary: true },
    });
  });

  it('weights KPI rewards by the immutable team allocation snapshot', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
      employeeId: 1,
      payrollPeriodId: 2,
      employeeCodeSnapshot: 'NV001',
      employeeNameSnapshot: 'Nhân sự A',
      jobTitleSnapshot: 'Editor',
      teamIdSnapshot: 10,
      teamNameSnapshot: 'Team A',
      teamSnapshots: [
        {
          teamId: 10,
          teamNameSnapshot: 'Team A',
          salaryWeightPercent: decimal(60),
        },
        {
          teamId: 20,
          teamNameSnapshot: 'Team B',
          salaryWeightPercent: decimal(40),
        },
      ],
    });
    prisma.employeeKpiAssignment.findMany.mockResolvedValue([
      groupAssignment(11, 'KPI A', 10, 10, 10, 'Team A'),
      groupAssignment(12, 'KPI B', 10, 10, 20, 'Team B'),
    ]);

    const result = await makeService(prisma).calculateEmployee(
      'admin',
      2,
      1,
      SalaryCalculationMode.PREVIEW,
    );

    expect(result.kpiRewardAmount).toBe('1800000');
    expect(result.kpiItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          teamId: 10,
          salaryWeightPercent: '60',
          earnedAmount: '1200000',
        }),
        expect.objectContaining({
          teamId: 20,
          salaryWeightPercent: '40',
          earnedAmount: '600000',
        }),
      ]),
    );
  });

  it('resolves batch permission once instead of authorizing every employee again', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      { employeeId: 1 },
    ]);
    const authorization = {
      resolveScope: jest.fn().mockResolvedValue({ type: 'ALL' }),
      resolvePermissionScope: jest.fn().mockResolvedValue({ type: 'ALL' }),
      getEmployeeId: jest.fn(),
    };
    const service = new SalaryService(
      prisma as never,
      authorization as never,
      { record: jest.fn(), notify: jest.fn() } as never,
    );
    const getBreakdown = jest.spyOn(service, 'getBreakdown');

    const result = await service.calculatePeriod(
      'admin',
      2,
      SalaryCalculationMode.PREVIEW,
    );

    expect(result.processedCount).toBe(1);
    expect(authorization.resolvePermissionScope).toHaveBeenCalledTimes(1);
    expect(getBreakdown).not.toHaveBeenCalled();
  });

  it('skips locked salaries when calculating the whole period', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      { employeeId: 1 },
      { employeeId: 2 },
    ]);
    prisma.salaryRecord.findMany.mockResolvedValue([
      { employeeId: 1, status: 'LOCKED' },
      { employeeId: 2, status: 'LOCKED' },
    ]);
    const service = makeService(prisma);

    const result = await service.calculatePeriod(
      'admin',
      2,
      SalaryCalculationMode.PERSIST,
    );

    expect(result).toMatchObject({
      processedCount: 0,
      skippedLockedCount: 2,
      warningCount: 0,
      data: [],
    });
    expect(prisma.baseSalaryHistory.findFirst).not.toHaveBeenCalled();
  });

  it('gives the persist transaction time for serialized round-trips and maps expiry to a retryable conflict', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      { employeeId: 1 },
    ]);
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Transaction already closed: A query cannot be executed on an expired transaction.',
        { code: 'P2028', clientVersion: 'test' },
      ),
    );
    const service = makeService(prisma);

    await expect(
      service.calculatePeriod('admin', 2, SalaryCalculationMode.PERSIST),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Phiên tính lương đã hết hạn, vui lòng thực hiện lại',
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxWait: 10_000, timeout: 30_000 }),
    );
  });

  it('keeps RPM independent when KPI and OKR both fail (regression case B)', async () => {
    const prisma = makePrismaMock();
    prisma.baseSalaryHistory.findFirst.mockResolvedValue({
      monthlyBaseSalary: decimal(16_000_000),
    });
    prisma.employeeKpiAssignment.findMany.mockResolvedValue([
      groupAssignment(11, 'KPI A', 7, 10),
    ]);
    prisma.employeeKpiRewardRate.findMany.mockResolvedValue([
      { kpiGroupId: 11, rewardAmount: decimal(2_000_000) },
    ]);
    prisma.employeeOkr.findMany.mockResolvedValue([
      {
        id: 21,
        title: 'OKR A',
        targetValue: decimal(10),
        actualValue: decimal(7),
        rewardAmount: decimal(1_000_000),
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'APPROVED',
      },
    ]);
    prisma.employeeRevenueRecord.findUnique.mockResolvedValue({
      officialRevenueAmount: decimal(280_000_000),
    });
    prisma.employeeTrafficRecord.findMany.mockResolvedValue([
      {
        views: 18_000_000n,
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'APPROVED',
      },
    ]);

    const result = await makeService(prisma).calculateEmployee(
      'admin',
      2,
      1,
      SalaryCalculationMode.PREVIEW,
    );

    expect(result).toMatchObject({
      kpiRewardAmount: '0',
      okrRewardAmount: '0',
      commissionAmount: '1120000',
      rpmRewardAmount: '1440000',
      totalSalaryAmount: '18560000',
    });
  });

  it('returns readiness warnings instead of silently treating missing inputs as complete', async () => {
    const prisma = makePrismaMock();
    prisma.baseSalaryHistory.findFirst.mockResolvedValue(null);
    prisma.employeeRevenueRecord.findUnique.mockResolvedValue(null);
    prisma.employeeTrafficRecord.findMany.mockResolvedValue([]);

    const result = await makeService(prisma).calculateEmployee(
      'admin',
      2,
      1,
      SalaryCalculationMode.PREVIEW,
    );

    expect(result.status).toBe('WARNING');
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        'BASE_SALARY_MISSING',
        'REVENUE_MISSING',
        'TRAFFIC_MISSING',
      ]),
    );
  });
});

describe('SalaryService list filters', () => {
  it('filters period snapshots by all teams in the selected department', async () => {
    const prisma = makePrismaMock();
    prisma.team.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);

    await makeService(prisma).list('admin', 2, {
      page: 1,
      pageSize: 100,
      departmentId: 3,
    });

    expect(prisma.team.findMany).toHaveBeenCalledWith({
      where: { departmentId: 3 },
      select: { id: true },
    });
    expect(prisma.payrollPeriodEmployeeSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              AND: expect.arrayContaining([
                { teamIdSnapshot: { in: [10, 11] } },
              ]),
            }),
          ]),
        }),
      }),
    );
  });
});

function approvalRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 30,
    employeeId: 1,
    payrollPeriodId: 2,
    versionNumber: 1,
    parentSalaryRecordId: null,
    status: 'PENDING',
    calculationWarnings: [],
    approvedByUserId: null,
    approvedAt: null,
    lockedAt: null,
    totalSalaryAmount: decimal(32_250_000),
    payrollPeriod: { status: 'IN_REVIEW' },
    ...overrides,
  };
}

function makeWorkflowService(prisma: Record<string, unknown>) {
  const auditLog = {
    record: jest.fn(),
    recordMany: jest.fn(),
    notify: jest.fn(),
  };
  const authorization = {
    resolveScope: jest.fn().mockResolvedValue({ type: 'ALL' }),
    resolvePermissionScope: jest.fn().mockResolvedValue({ type: 'ALL' }),
    getEmployeeId: jest.fn(),
  };
  const service = new SalaryService(
    prisma as never,
    authorization as never,
    auditLog as never,
  );
  const getBreakdown = jest
    .spyOn(service, 'getBreakdown')
    .mockResolvedValue({ id: 'result' } as never);
  return { service, auditLog, getBreakdown };
}

describe('SalaryService approval and revision workflow', () => {
  it('approves and locks a ready salary atomically', async () => {
    const record = approvalRecord();
    const prisma = {
      salaryRecord: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ employeeId: 1, payrollPeriodId: 2 })
          .mockResolvedValueOnce(record),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) =>
          callback(prisma),
        ),
    };
    const { service, auditLog, getBreakdown } = makeWorkflowService(prisma);

    await expect(service.approve('manager-user', 30)).resolves.toMatchObject({
      id: 30,
      status: 'LOCKED',
      versionNumber: 1,
    });

    expect(prisma.salaryRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 30, status: 'PENDING' },
      data: expect.objectContaining({
        status: 'LOCKED',
        approvedByUserId: 'manager-user',
        approvedAt: expect.any(Date),
        lockedAt: expect.any(Date),
      }),
    });
    expect(auditLog.recordMany).toHaveBeenCalledWith(
      prisma,
      expect.arrayContaining([
        expect.objectContaining({ action: 'SALARY_APPROVED' }),
        expect.objectContaining({ action: 'SALARY_LOCKED' }),
      ]),
    );
    expect(getBreakdown).not.toHaveBeenCalled();
  });

  it('blocks final approval when the salary still has readiness warnings', async () => {
    const prisma = {
      salaryRecord: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ employeeId: 1, payrollPeriodId: 2 })
          .mockResolvedValueOnce(
            approvalRecord({
              status: 'WARNING',
              calculationWarnings: [
                { code: 'REVENUE_MISSING', message: 'Thiếu doanh thu' },
              ],
            }),
          ),
        updateMany: jest.fn(),
      },
      $transaction: jest
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) =>
          callback(prisma),
        ),
    };
    const { service } = makeWorkflowService(prisma);

    await expect(service.approve('manager-user', 30)).rejects.toMatchObject({
      code: 'SALARY_NOT_READY_FOR_APPROVAL',
    });
    expect(prisma.salaryRecord.updateMany).not.toHaveBeenCalled();
  });

  it('lets only one concurrent approval claim the pending record', async () => {
    const prisma = {
      salaryRecord: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ employeeId: 1, payrollPeriodId: 2 })
          .mockResolvedValueOnce(approvalRecord()),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) =>
          callback(prisma),
        ),
    };
    const { service, auditLog } = makeWorkflowService(prisma);

    await expect(service.approve('manager-user', 30)).rejects.toMatchObject({
      code: 'SALARY_ALREADY_LOCKED',
    });
    expect(auditLog.recordMany).not.toHaveBeenCalled();
  });

  it('creates a new draft version while preserving the locked snapshot', async () => {
    const source = {
      ...approvalRecord({ status: 'LOCKED', lockedAt: new Date() }),
      rewardRuleSetId: 3,
      revenueRewardBracketId: 4,
      baseSalaryAmount: decimal(18_000_000),
      kpiRewardAmount: decimal(3_500_000),
      okrRewardAmount: decimal(1_000_000),
      revenueAmountSnapshot: decimal(500_000_000),
      commissionRatePercentSnapshot: decimal('0.6'),
      commissionAmount: decimal(3_000_000),
      totalViewsSnapshot: 56_250_000n,
      rpmRatePer1000ViewsSnapshot: decimal(120),
      rpmRewardAmount: decimal(6_750_000),
      additionalComponentAmount: decimal(1_000_000),
      kpiItems: [],
      okrItems: [],
      components: [
        {
          componentCode: 'BONUS',
          componentName: 'Thưởng nóng dự án',
          amount: decimal(1_000_000),
          note: null,
          source: 'MANUAL',
          createdByUserId: 'leader-user',
          createdAt: new Date('2026-09-20T03:00:00Z'),
        },
      ],
    };
    const prisma = {
      salaryRecord: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ employeeId: 1, payrollPeriodId: 2 })
          .mockResolvedValueOnce(source),
        findFirst: jest.fn().mockResolvedValue({
          id: 30,
          versionNumber: 1,
          status: 'LOCKED',
          payrollPeriod: { status: 'IN_REVIEW' },
        }),
        create: jest.fn().mockResolvedValue({
          id: 31,
          versionNumber: 2,
          status: 'PENDING',
          totalSalaryAmount: decimal(32_250_000),
        }),
      },
      $transaction: jest
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) =>
          callback(prisma),
        ),
    };
    const { service, auditLog, getBreakdown } = makeWorkflowService(prisma);

    await expect(
      service.createRevision('admin-user', 30),
    ).resolves.toMatchObject({ id: 31, status: 'PENDING', versionNumber: 2 });

    expect(prisma.salaryRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        parentSalaryRecordId: 30,
        versionNumber: 2,
        status: 'PENDING',
        calculatedByUserId: 'admin-user',
        components: {
          createMany: {
            data: [
              expect.objectContaining({
                componentName: 'Thưởng nóng dự án',
                createdByUserId: 'leader-user',
                createdAt: new Date('2026-09-20T03:00:00Z'),
              }),
            ],
          },
        },
      }),
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        action: 'SALARY_REVISION_CREATED',
        entityId: 31,
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxWait: 10_000, timeout: 30_000 }),
    );
    expect(getBreakdown).not.toHaveBeenCalled();
  });
});

describe('SalaryService extra bonus', () => {
  function bonusPrisma(overrides: Record<string, unknown> = {}) {
    const prisma = {
      salaryRecord: {
        findUnique: jest.fn().mockResolvedValue(approvalRecord(overrides)),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ totalSalaryAmount: decimal(33_250_000) }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      salaryRecordComponent: {
        create: jest.fn().mockResolvedValue({ id: 70 }),
        findFirst: jest.fn().mockResolvedValue({
          componentName: 'Thưởng nóng dự án',
          amount: decimal(1_000_000),
          source: 'MANUAL',
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest
        .fn()
        .mockImplementation((callback: (tx: unknown) => unknown) =>
          callback(prisma),
        ),
    };
    return prisma;
  }

  it('adds a manual bonus and raises the draft total in the same transaction', async () => {
    const prisma = bonusPrisma();
    const { service, auditLog } = makeWorkflowService(prisma);

    await expect(
      service.addBonus('leader-user', 30, {
        name: 'Thưởng nóng dự án',
        amount: '1000000',
        note: 'Hoàn thành sớm',
      }),
    ).resolves.toEqual({
      id: 70,
      salaryRecordId: 30,
      totalSalaryAmount: '33250000',
    });

    expect(prisma.salaryRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 30, status: { in: ['PENDING', 'WARNING'] } },
      data: {
        additionalComponentAmount: { increment: decimal(1_000_000) },
        totalSalaryAmount: { increment: decimal(1_000_000) },
      },
    });
    expect(prisma.salaryRecordComponent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        salaryRecordId: 30,
        componentCode: 'BONUS',
        componentName: 'Thưởng nóng dự án',
        source: 'MANUAL',
        createdByUserId: 'leader-user',
      }),
      select: { id: true },
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        action: 'SALARY_BONUS_ADDED',
        targetEmployeeId: 1,
        beforeData: { totalSalaryAmount: '32250000' },
        afterData: expect.objectContaining({
          bonusAmount: '1000000',
          totalSalaryAmount: '33250000',
        }),
      }),
    );
  });

  it('refuses to add a bonus to a locked salary', async () => {
    const prisma = bonusPrisma({ status: 'LOCKED' });
    const { service } = makeWorkflowService(prisma);

    await expect(
      service.addBonus('leader-user', 30, { name: 'Thưởng', amount: '1' }),
    ).rejects.toMatchObject({ code: 'SALARY_ALREADY_LOCKED' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not create the bonus when the salary is approved concurrently', async () => {
    const prisma = bonusPrisma();
    prisma.salaryRecord.updateMany.mockResolvedValue({ count: 0 });
    const { service, auditLog } = makeWorkflowService(prisma);

    await expect(
      service.addBonus('leader-user', 30, { name: 'Thưởng', amount: '1' }),
    ).rejects.toMatchObject({ code: 'SALARY_ALREADY_LOCKED' });
    expect(prisma.salaryRecordComponent.create).not.toHaveBeenCalled();
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('removes a manual bonus and lowers the draft total', async () => {
    const prisma = bonusPrisma();
    prisma.salaryRecord.findUniqueOrThrow.mockResolvedValue({
      totalSalaryAmount: decimal(32_250_000),
    });
    const { service, auditLog } = makeWorkflowService(prisma);

    await expect(
      service.removeBonus('leader-user', 30, 70),
    ).resolves.toMatchObject({ id: 70, totalSalaryAmount: '32250000' });

    expect(prisma.salaryRecordComponent.deleteMany).toHaveBeenCalledWith({
      where: { id: 70, salaryRecordId: 30 },
    });
    expect(prisma.salaryRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 30, status: { in: ['PENDING', 'WARNING'] } },
      data: {
        additionalComponentAmount: { decrement: decimal(1_000_000) },
        totalSalaryAmount: { decrement: decimal(1_000_000) },
      },
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        action: 'SALARY_BONUS_REMOVED',
        beforeData: expect.objectContaining({
          totalSalaryAmount: '33250000',
        }),
        afterData: { totalSalaryAmount: '32250000' },
      }),
    );
  });

  it('subtracts a bonus only once when two removals race', async () => {
    const prisma = bonusPrisma();
    prisma.salaryRecordComponent.deleteMany.mockResolvedValue({ count: 0 });
    const { service } = makeWorkflowService(prisma);

    await expect(
      service.removeBonus('leader-user', 30, 70),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.salaryRecord.updateMany).not.toHaveBeenCalled();
  });

  it('keeps system components out of manual bonus removal', async () => {
    const prisma = bonusPrisma();
    prisma.salaryRecordComponent.findFirst.mockResolvedValue({
      componentName: 'Phụ cấp hệ thống',
      amount: decimal(500_000),
      source: 'SYSTEM',
    });
    const { service } = makeWorkflowService(prisma);

    await expect(
      service.removeBonus('leader-user', 30, 70),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
