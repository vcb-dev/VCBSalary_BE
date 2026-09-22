import { KpiPeriodTargetsService } from '../kpi-period-targets.service';

interface PrismaMock {
  payrollPeriod: {
    findUnique: jest.Mock;
  };
  kpiItem: {
    findUnique: jest.Mock;
  };
  kpiPeriodTarget: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    upsert: jest.Mock;
  };
  $transaction: jest.Mock;
}

function decimal(value: number) {
  return { toNumber: () => value };
}

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    payrollPeriod: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', status: 'OPEN' }),
    },
    kpiItem: {
      findUnique: jest.fn().mockResolvedValue({ id: 'item-1' }),
    },
    kpiPeriodTarget: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: PrismaMock) => unknown)(mock);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  return mock;
}

function makeAuditLogMock() {
  return { record: jest.fn().mockResolvedValue({}) };
}

describe('KpiPeriodTargetsService', () => {
  describe('listForPeriod', () => {
    it('rejects an unknown payroll period', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue(null);
      const service = new KpiPeriodTargetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(service.listForPeriod('unknown')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('flattens kpi item/group info onto each target row', async () => {
      const prisma = makePrismaMock();
      prisma.kpiPeriodTarget.findMany.mockResolvedValue([
        {
          id: 't1',
          payrollPeriodId: 'p1',
          kpiItemId: 'item-1',
          targetValue: decimal(1000),
          createdByUserId: 'user-admin',
          createdAt: new Date('2026-09-01'),
          updatedAt: new Date('2026-09-01'),
          kpiItem: {
            code: 'VIEWS',
            name: 'Views',
            unit: 'views',
            kpiGroup: { id: 'g1', code: 'CONTENT', name: 'Content' },
          },
        },
      ]);
      const service = new KpiPeriodTargetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      const result = await service.listForPeriod('p1');

      expect(result[0]).toMatchObject({
        kpiItemId: 'item-1',
        kpiItemCode: 'VIEWS',
        kpiGroupId: 'g1',
        kpiGroupCode: 'CONTENT',
      });
    });
  });

  describe('setTarget', () => {
    it('rejects changing a target after the payroll period is CLOSED', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'CLOSED',
      });
      const service = new KpiPeriodTargetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.setTarget('p1', 'item-1', { targetValue: 100 }, 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.kpiPeriodTarget.upsert).not.toHaveBeenCalled();
    });

    it('rejects an unknown payroll period', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue(null);
      const service = new KpiPeriodTargetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.setTarget(
          'unknown',
          'item-1',
          { targetValue: 100 },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects an unknown kpi item', async () => {
      const prisma = makePrismaMock();
      prisma.kpiItem.findUnique.mockResolvedValue(null);
      const service = new KpiPeriodTargetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.setTarget('p1', 'unknown', { targetValue: 100 }, 'user-admin'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('creates a new target and records a CREATED audit entry when none exists yet', async () => {
      const prisma = makePrismaMock();
      prisma.kpiPeriodTarget.upsert.mockResolvedValue({ id: 't1' });
      const auditLog = makeAuditLogMock();
      const service = new KpiPeriodTargetsService(
        prisma as never,
        auditLog as never,
      );

      await service.setTarget(
        'p1',
        'item-1',
        { targetValue: 500 },
        'user-admin',
      );

      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'KPI_PERIOD_TARGET_CREATED' }),
      );
    });

    it('updates an existing target idempotently and records an UPDATED audit entry', async () => {
      const prisma = makePrismaMock();
      prisma.kpiPeriodTarget.findUnique.mockResolvedValue({
        id: 't1',
        targetValue: decimal(500),
      });
      prisma.kpiPeriodTarget.upsert.mockResolvedValue({ id: 't1' });
      const auditLog = makeAuditLogMock();
      const service = new KpiPeriodTargetsService(
        prisma as never,
        auditLog as never,
      );

      await service.setTarget(
        'p1',
        'item-1',
        { targetValue: 800 },
        'user-admin',
      );

      expect(prisma.kpiPeriodTarget.upsert).toHaveBeenCalledTimes(1);
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'KPI_PERIOD_TARGET_UPDATED' }),
      );
    });
  });
});
