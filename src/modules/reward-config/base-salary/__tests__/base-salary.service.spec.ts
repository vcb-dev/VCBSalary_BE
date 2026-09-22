import { validate } from 'class-validator';
import { BaseSalaryService } from '../base-salary.service';
import { currentBusinessDate } from '../../../../common/utils/date.util';
import { CreateKpiRewardRateDto } from '../../kpi-reward-rates/dto/kpi-reward-rate.dto';
import { CreateRevenueRewardBracketDto } from '../../reward-rule-sets/dto/revenue-reward-bracket.dto';
import { CreateBaseSalaryHistoryDto } from '../dto/base-salary-history.dto';

interface PrismaMock {
  employee: {
    findUnique: jest.Mock;
  };
  baseSalaryHistory: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    groupBy: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  salaryRecord: { count: jest.Mock };
  $transaction: jest.Mock;
}

function decimal(value: number) {
  return { toNumber: () => value };
}

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    employee: {
      findUnique: jest.fn().mockResolvedValue({ id: 'e1' }),
    },
    baseSalaryHistory: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    salaryRecord: { count: jest.fn().mockResolvedValue(0) },
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

describe('BaseSalaryService', () => {
  describe('listCurrentByEmployees', () => {
    it('maps the effective entry to each employee and keeps those without one', async () => {
      const prisma = makePrismaMock();
      prisma.baseSalaryHistory.findMany.mockResolvedValue([
        { id: 1, employeeId: 10, effectiveFrom: new Date('2026-01-01') },
      ]);
      prisma.baseSalaryHistory.groupBy.mockResolvedValue([
        { employeeId: 10, _count: { _all: 2 } },
        { employeeId: 11, _count: { _all: 1 } },
      ]);
      const service = new BaseSalaryService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      const result = await service.listCurrentByEmployees([10, 11]);

      expect(result).toEqual([
        {
          employeeId: 10,
          entryCount: 2,
          current: {
            id: 1,
            employeeId: 10,
            effectiveFrom: new Date('2026-01-01'),
          },
        },
        { employeeId: 11, entryCount: 1, current: null },
      ]);
      expect(prisma.baseSalaryHistory.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { employeeId: { in: [10, 11] } } }),
      );
    });

    it('keeps an entry effective through the whole effectiveTo day', async () => {
      const prisma = makePrismaMock();
      const service = new BaseSalaryService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await service.listCurrentByEmployees([10]);

      const today = currentBusinessDate();
      expect(prisma.baseSalaryHistory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            employeeId: { in: [10] },
            effectiveFrom: { lte: today },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
          },
        }),
      );
    });

    it('queries every employee when no ids are given', async () => {
      const prisma = makePrismaMock();
      const service = new BaseSalaryService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await service.listCurrentByEmployees();

      expect(prisma.baseSalaryHistory.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  describe('create', () => {
    it('rejects an unknown employee', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue(null);
      const service = new BaseSalaryService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create(
          'unknown',
          { monthlyBaseSalary: 10_000_000, effectiveFrom: '2026-09-01' },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects effectiveFrom that is not after the latest existing entry', async () => {
      const prisma = makePrismaMock();
      prisma.baseSalaryHistory.findFirst.mockResolvedValue({
        id: 'bsh-1',
        effectiveFrom: new Date('2026-09-01'),
        effectiveTo: null,
      });
      const service = new BaseSalaryService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create(
          'e1',
          { monthlyBaseSalary: 10_000_000, effectiveFrom: '2026-08-01' },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('keeps the previous salary valid until a future salary reaches its start date', async () => {
      const prisma = makePrismaMock();
      prisma.baseSalaryHistory.findFirst.mockResolvedValue({
        id: 'bsh-1',
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: null,
      });
      prisma.baseSalaryHistory.create.mockResolvedValue({ id: 'bsh-2' });
      const auditLog = makeAuditLogMock();
      const service = new BaseSalaryService(prisma as never, auditLog as never);

      await service.create(
        'e1',
        { monthlyBaseSalary: 12_000_000, effectiveFrom: '2027-01-01' },
        'user-admin',
      );

      expect(prisma.baseSalaryHistory.update).toHaveBeenCalledWith({
        where: { id: 'bsh-1' },
        data: { effectiveTo: new Date('2026-12-31') },
      });
      const createArg = (
        prisma.baseSalaryHistory.create.mock.calls[0] as [
          {
            data: {
              employeeId: string;
              monthlyBaseSalary: number;
              effectiveFrom: Date;
              effectiveTo: null;
            };
          },
        ]
      )[0];
      expect(createArg.data.employeeId).toBe('e1');
      expect(createArg.data.monthlyBaseSalary).toBe(12_000_000);
      expect(createArg.data.effectiveFrom).toEqual(new Date('2027-01-01'));
      expect(createArg.data.effectiveTo).toBeNull();
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'BASE_SALARY_HISTORY_CREATED' }),
      );
    });
  });

  describe('update', () => {
    it('rejects an unknown history entry', async () => {
      const prisma = makePrismaMock();
      prisma.baseSalaryHistory.findUnique.mockResolvedValue(null);
      const service = new BaseSalaryService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.update('unknown', { monthlyBaseSalary: 1 }, 'user-admin'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects an update that overlaps a sibling entry', async () => {
      const prisma = makePrismaMock();
      prisma.baseSalaryHistory.findUnique.mockResolvedValue({
        id: 'bsh-2',
        employeeId: 'e1',
        monthlyBaseSalary: decimal(12_000_000),
        effectiveFrom: new Date('2026-09-01'),
        effectiveTo: null,
      });
      prisma.baseSalaryHistory.findMany.mockResolvedValue([
        {
          id: 'bsh-1',
          effectiveFrom: new Date('2026-01-01'),
          effectiveTo: new Date('2026-06-30'),
        },
      ]);
      const service = new BaseSalaryService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.update('bsh-2', { effectiveFrom: '2026-06-01' }, 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('shifts the adjacent previous entry so the timeline stays continuous', async () => {
      const prisma = makePrismaMock();
      prisma.baseSalaryHistory.findUnique.mockResolvedValue({
        id: 'bsh-2',
        employeeId: 'e1',
        monthlyBaseSalary: decimal(12_000_000),
        effectiveFrom: new Date('2026-09-19'),
        effectiveTo: null,
      });
      prisma.baseSalaryHistory.findMany.mockResolvedValue([
        {
          id: 'bsh-1',
          effectiveFrom: new Date('2026-09-01'),
          effectiveTo: new Date('2026-09-18'),
        },
      ]);
      prisma.baseSalaryHistory.update.mockResolvedValue({ id: 'bsh-2' });
      const service = new BaseSalaryService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await service.update(
        'bsh-2',
        { effectiveFrom: '2026-09-25' },
        'user-admin',
      );

      expect(prisma.baseSalaryHistory.update).toHaveBeenCalledWith({
        where: { id: 'bsh-1' },
        data: { effectiveTo: new Date('2026-09-24') },
      });
    });

    it('rejects changing a base salary range already used by a locked salary snapshot', async () => {
      const prisma = makePrismaMock();
      prisma.baseSalaryHistory.findUnique.mockResolvedValue({
        id: 'bsh-2',
        employeeId: 1,
        monthlyBaseSalary: decimal(12_000_000),
        effectiveFrom: new Date('2026-09-01'),
        effectiveTo: null,
      });
      prisma.salaryRecord.count.mockResolvedValue(1);
      const service = new BaseSalaryService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.update(
          'bsh-2',
          { monthlyBaseSalary: 13_000_000 },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('applies a non-overlapping update', async () => {
      const prisma = makePrismaMock();
      prisma.baseSalaryHistory.findUnique.mockResolvedValue({
        id: 'bsh-2',
        employeeId: 'e1',
        monthlyBaseSalary: decimal(12_000_000),
        effectiveFrom: new Date('2026-09-01'),
        effectiveTo: null,
      });
      prisma.baseSalaryHistory.update.mockResolvedValue({ id: 'bsh-2' });
      const auditLog = makeAuditLogMock();
      const service = new BaseSalaryService(prisma as never, auditLog as never);

      await service.update(
        'bsh-2',
        { monthlyBaseSalary: 13_000_000 },
        'user-admin',
      );

      const updateArg = (
        prisma.baseSalaryHistory.update.mock.calls[0] as [
          { where: { id: string }; data: { monthlyBaseSalary: number } },
        ]
      )[0];
      expect(updateArg.where).toEqual({ id: 'bsh-2' });
      expect(updateArg.data.monthlyBaseSalary).toBe(13_000_000);
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'BASE_SALARY_HISTORY_UPDATED' }),
      );
    });
  });
});

// Hợp đồng độ chính xác tiền tệ áp cho cả 3 DTO của reward-config (lương cơ bản, mức thưởng
// KPI, bậc thưởng doanh thu) — tiền luôn đi qua JSON dưới dạng chuỗi, số JSON bị từ chối.
describe('money DTO precision contract', () => {
  it('accepts an 18-digit amount as a decimal string', async () => {
    const dto = Object.assign(new CreateBaseSalaryHistoryDto(), {
      monthlyBaseSalary: '999999999999999999',
      effectiveFrom: '2026-09-01',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects JSON numbers so money cannot lose precision in JavaScript', async () => {
    const dto = Object.assign(new CreateKpiRewardRateDto(), {
      kpiGroupId: 1,
      rewardAmount: Number('999999999999999999'),
      effectiveFrom: '2026-09-01',
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'rewardAmount')).toBe(
      true,
    );
  });

  it('validates bracket money and rates as strings', async () => {
    const dto = Object.assign(new CreateRevenueRewardBracketDto(), {
      label: 'Bậc 1',
      minRevenueAmount: '0',
      maxRevenueAmount: '500000000',
      commissionRatePercent: '0.6000',
      rpmRatePer1000Views: '120.5000',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
