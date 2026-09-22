import { KpiRewardRatesService } from '../kpi-reward-rates.service';

interface PrismaMock {
  employee: { findUnique: jest.Mock };
  kpiGroup: { findUnique: jest.Mock };
  employeeKpiRewardRate: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    groupBy: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  salaryRecordKpiItem: { count: jest.Mock };
  $transaction: jest.Mock;
}

function decimal(value: number) {
  return { toString: () => String(value) };
}

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    employee: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    kpiGroup: { findUnique: jest.fn().mockResolvedValue({ id: 10 }) },
    employeeKpiRewardRate: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    salaryRecordKpiItem: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation(
    (callback: (tx: PrismaMock) => unknown) => callback(mock),
  );
  return mock;
}

function makeAuditLogMock() {
  return { record: jest.fn().mockResolvedValue({}) };
}

function rate(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    employeeId: 1,
    kpiGroupId: 10,
    rewardAmount: decimal(2_000_000),
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    ...overrides,
  };
}

describe('KpiRewardRatesService', () => {
  describe('listCurrentByEmployees', () => {
    it('sums the active rates per employee and keeps those without any', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiRewardRate.findMany.mockResolvedValue([
        {
          id: 1,
          employeeId: 10,
          kpiGroupId: 100,
          rewardAmount: 1_000_000,
          effectiveFrom: new Date('2026-01-01'),
        },
        {
          id: 2,
          employeeId: 10,
          kpiGroupId: 101,
          rewardAmount: 500_000,
          effectiveFrom: new Date('2026-01-01'),
        },
      ]);
      prisma.employeeKpiRewardRate.groupBy.mockResolvedValue([
        { employeeId: 10, _count: { _all: 3 } },
        { employeeId: 11, _count: { _all: 0 } },
      ]);
      const service = new KpiRewardRatesService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      const result = await service.listCurrentByEmployees([10, 11]);

      expect(result[0]).toMatchObject({
        employeeId: 10,
        rateCount: 3,
        totalRewardAmount: '1500000',
      });
      expect(result[0].activeRates).toHaveLength(2);
      expect(result[1]).toMatchObject({
        employeeId: 11,
        rateCount: 0,
        activeRates: [],
        totalRewardAmount: '0',
      });
    });

    it('keeps only the latest rate when a group has overlapping ranges', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiRewardRate.findMany.mockResolvedValue([
        {
          id: 1,
          employeeId: 10,
          kpiGroupId: 100,
          rewardAmount: 1_000_000,
          effectiveFrom: new Date('2026-01-01'),
        },
        {
          id: 2,
          employeeId: 10,
          kpiGroupId: 100,
          rewardAmount: 2_000_000,
          effectiveFrom: new Date('2026-06-01'),
        },
      ]);
      prisma.employeeKpiRewardRate.groupBy.mockResolvedValue([
        { employeeId: 10, _count: { _all: 2 } },
      ]);
      const service = new KpiRewardRatesService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      const result = await service.listCurrentByEmployees([10]);

      expect(result[0].activeRates).toHaveLength(1);
      expect(result[0].totalRewardAmount).toBe('2000000');
    });
  });

  it('rejects creating a rate for an unknown KPI group', async () => {
    const prisma = makePrismaMock();
    prisma.kpiGroup.findUnique.mockResolvedValue(null);
    const service = new KpiRewardRatesService(
      prisma as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.create(
        1,
        {
          kpiGroupId: 999,
          rewardAmount: 2_000_000,
          effectiveFrom: '2026-09-01',
        },
        '00000000-0000-0000-0000-000000000001',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('closes the current rate on the day before the new one', async () => {
    const prisma = makePrismaMock();
    prisma.employeeKpiRewardRate.findFirst.mockResolvedValue(rate());
    prisma.employeeKpiRewardRate.create.mockResolvedValue(
      rate({ id: 101, effectiveFrom: new Date('2026-09-01') }),
    );
    const audit = makeAuditLogMock();
    const service = new KpiRewardRatesService(prisma as never, audit as never);

    await service.create(
      1,
      { kpiGroupId: 10, rewardAmount: 2_500_000, effectiveFrom: '2026-09-01' },
      '00000000-0000-0000-0000-000000000001',
    );

    expect(prisma.employeeKpiRewardRate.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { effectiveTo: new Date('2026-08-31') },
    });
    const createArg = (
      prisma.employeeKpiRewardRate.create.mock.calls[0] as [
        {
          data: {
            employeeId: number;
            kpiGroupId: number;
            rewardAmount: number;
          };
        },
      ]
    )[0];
    expect(createArg.data).toEqual(
      expect.objectContaining({
        employeeId: 1,
        kpiGroupId: 10,
        rewardAmount: 2_500_000,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: 'KPI_REWARD_RATE_CREATED' }),
    );
  });

  it('rejects a new rate that is not after the latest change', async () => {
    const prisma = makePrismaMock();
    prisma.employeeKpiRewardRate.findFirst.mockResolvedValue(
      rate({ effectiveFrom: new Date('2026-09-01') }),
    );
    const service = new KpiRewardRatesService(
      prisma as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.create(
        1,
        {
          kpiGroupId: 10,
          rewardAmount: 2_500_000,
          effectiveFrom: '2026-08-01',
        },
        '00000000-0000-0000-0000-000000000001',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects an update whose effective range overlaps a sibling', async () => {
    const prisma = makePrismaMock();
    prisma.employeeKpiRewardRate.findUnique.mockResolvedValue(
      rate({ id: 101, effectiveFrom: new Date('2026-09-01') }),
    );
    prisma.employeeKpiRewardRate.findMany.mockResolvedValue([
      rate({
        id: 100,
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: new Date('2026-06-30'),
      }),
    ]);
    const service = new KpiRewardRatesService(
      prisma as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.update(
        101,
        { effectiveFrom: '2026-05-01' },
        '00000000-0000-0000-0000-000000000001',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('shifts the adjacent previous rate so the timeline stays continuous', async () => {
    const prisma = makePrismaMock();
    prisma.employeeKpiRewardRate.findUnique.mockResolvedValue(
      rate({ id: 101, effectiveFrom: new Date('2026-09-19') }),
    );
    prisma.employeeKpiRewardRate.findMany.mockResolvedValue([
      rate({
        id: 100,
        effectiveFrom: new Date('2026-09-01'),
        effectiveTo: new Date('2026-09-18'),
      }),
    ]);
    prisma.employeeKpiRewardRate.update.mockResolvedValue(rate({ id: 101 }));
    const service = new KpiRewardRatesService(
      prisma as never,
      makeAuditLogMock() as never,
    );

    await service.update(
      101,
      { effectiveFrom: '2026-09-25' },
      '00000000-0000-0000-0000-000000000001',
    );

    expect(prisma.employeeKpiRewardRate.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { effectiveTo: new Date('2026-09-24') },
    });
  });

  it('resolves the rate using a closed effective range', async () => {
    const prisma = makePrismaMock();
    const service = new KpiRewardRatesService(
      prisma as never,
      makeAuditLogMock() as never,
    );
    const at = new Date('2026-09-30');

    await service.findEffectiveRate(1, 10, at);

    expect(prisma.employeeKpiRewardRate.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          employeeId: 1,
          kpiGroupId: 10,
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
        },
      }),
    );
  });

  it('rejects changing a KPI rate already used by a locked salary snapshot', async () => {
    const prisma = makePrismaMock();
    prisma.employeeKpiRewardRate.findUnique.mockResolvedValue(rate());
    prisma.salaryRecordKpiItem.count.mockResolvedValue(1);
    const service = new KpiRewardRatesService(
      prisma as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.update(
        100,
        { rewardAmount: 2_500_000 },
        '00000000-0000-0000-0000-000000000001',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reconnects the previous range when deleting a later rate', async () => {
    const prisma = makePrismaMock();
    const current = rate({ id: 101, effectiveFrom: new Date('2026-09-01') });
    const previous = rate({
      id: 100,
      effectiveFrom: new Date('2026-01-01'),
      effectiveTo: new Date('2026-09-01'),
    });
    prisma.employeeKpiRewardRate.findUnique.mockResolvedValue(current);
    prisma.employeeKpiRewardRate.findFirst.mockResolvedValue(previous);
    const service = new KpiRewardRatesService(
      prisma as never,
      makeAuditLogMock() as never,
    );

    await service.remove(101, '00000000-0000-0000-0000-000000000001');

    expect(prisma.employeeKpiRewardRate.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { effectiveTo: null },
    });
    expect(prisma.employeeKpiRewardRate.delete).toHaveBeenCalledWith({
      where: { id: 101 },
    });
  });
});
