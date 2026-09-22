import { Prisma } from '@prisma/client';
import { RewardRuleSetsService } from '../reward-rule-sets.service';

interface PrismaMock {
  rewardRuleSet: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  revenueRewardBracket: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    createMany: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  payrollPeriod: {
    findUnique: jest.Mock;
  };
  $transaction: jest.Mock;
}

function decimal(value: number | null) {
  if (value === null) return null;
  return new Prisma.Decimal(value);
}

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    rewardRuleSet: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
    },
    revenueRewardBracket: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn(),
      delete: jest.fn(),
    },
    payrollPeriod: {
      findUnique: jest.fn(),
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

describe('RewardRuleSetsService', () => {
  describe('create', () => {
    it('assigns version 1 when no rule set exists yet', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.create.mockResolvedValue({
        id: 'rrs-1',
        version: 1,
      });
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await service.create({ achievementThresholdPercent: 80 }, 'user-admin');

      const createArg = (
        prisma.rewardRuleSet.create.mock.calls[0] as [
          { data: { version: number } },
        ]
      )[0];
      expect(createArg.data.version).toBe(1);
    });

    it('increments version based on the latest existing version', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.findFirst.mockResolvedValue({ version: 3 });
      prisma.rewardRuleSet.create.mockResolvedValue({
        id: 'rrs-4',
        version: 4,
      });
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await service.create({ achievementThresholdPercent: 80 }, 'user-admin');

      const createArg = (
        prisma.rewardRuleSet.create.mock.calls[0] as [
          { data: { version: number } },
        ]
      )[0];
      expect(createArg.data.version).toBe(4);
    });

    it('clones revenue brackets from the source rule set when requested', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.create.mockResolvedValue({
        id: 'rrs-2',
        version: 2,
      });
      prisma.revenueRewardBracket.findMany.mockResolvedValue([
        {
          label: 'Bậc 1',
          minRevenueAmount: decimal(0),
          maxRevenueAmount: decimal(100),
          commissionRatePercent: decimal(1),
          rpmRatePer1000Views: decimal(10),
          sortOrder: 0,
        },
      ]);
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await service.create(
        {
          achievementThresholdPercent: 80,
          cloneRevenueBracketsFromRuleSetId: 'rrs-1',
        },
        'user-admin',
      );

      expect(prisma.revenueRewardBracket.createMany).toHaveBeenCalledTimes(1);
      const arg = (
        prisma.revenueRewardBracket.createMany.mock.calls[0] as [
          { data: { rewardRuleSetId: string; label: string }[] },
        ]
      )[0];
      expect(arg.data[0]).toMatchObject({
        rewardRuleSetId: 'rrs-2',
        label: 'Bậc 1',
      });
    });
  });

  describe('activate', () => {
    it('rejects activating a rule set that is not DRAFT', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-1',
        status: 'ACTIVE',
      });
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.activate('rrs-1', 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('archives the previously ACTIVE rule set when activating a new one', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-2',
        status: 'DRAFT',
      });
      prisma.rewardRuleSet.findFirst.mockResolvedValue({
        id: 'rrs-1',
        status: 'ACTIVE',
      });
      prisma.rewardRuleSet.update.mockResolvedValue({
        id: 'rrs-2',
        status: 'ACTIVE',
      });
      prisma.rewardRuleSet.findUniqueOrThrow.mockResolvedValue({
        id: 'rrs-2',
        status: 'ACTIVE',
      });
      prisma.revenueRewardBracket.findMany.mockResolvedValue([
        {
          minRevenueAmount: decimal(0),
          maxRevenueAmount: null,
        },
      ]);
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await service.activate('rrs-2', 'user-admin');

      expect(prisma.rewardRuleSet.update).toHaveBeenCalledWith({
        where: { id: 'rrs-1' },
        data: { status: 'ARCHIVED' },
      });
      expect(prisma.rewardRuleSet.findFirst).toHaveBeenCalledWith({
        where: { status: 'ACTIVE', id: { not: 'rrs-2' } },
      });
      expect(prisma.rewardRuleSet.updateMany).toHaveBeenCalledWith({
        where: { id: 'rrs-2', status: 'DRAFT' },
        data: { status: 'ACTIVE' },
      });
    });

    it('rejects activation when revenue brackets have a gap', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-2',
        status: 'DRAFT',
      });
      prisma.revenueRewardBracket.findMany.mockResolvedValue([
        { minRevenueAmount: decimal(0), maxRevenueAmount: decimal(100) },
        { minRevenueAmount: decimal(200), maxRevenueAmount: null },
      ]);
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.activate('rrs-2', 'user-admin'),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      // Activation claim row parent trước khi validate để không thể chạy xen kẽ với CRUD bracket.
      expect(prisma.rewardRuleSet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rrs-2', status: 'DRAFT' },
        }),
      );
    });
  });

  describe('archive', () => {
    it('rejects archiving a rule set that is already ARCHIVED', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-1',
        status: 'ARCHIVED',
      });
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.archive('rrs-1', 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('createBracket', () => {
    it('rejects when the rule set is not DRAFT', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-1',
        status: 'ACTIVE',
      });
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.createBracket(
          'rrs-1',
          {
            label: 'Bậc mới',
            minRevenueAmount: 0,
            commissionRatePercent: 1,
            rpmRatePer1000Views: 10,
          },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects maxRevenueAmount <= minRevenueAmount', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-1',
        status: 'DRAFT',
      });
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.createBracket(
          'rrs-1',
          {
            label: 'Bậc lỗi',
            minRevenueAmount: 100,
            maxRevenueAmount: 100,
            commissionRatePercent: 1,
            rpmRatePer1000Views: 10,
          },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects a bracket that overlaps an existing one', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-1',
        status: 'DRAFT',
      });
      prisma.revenueRewardBracket.findMany.mockResolvedValue([
        {
          label: 'Bậc 1',
          minRevenueAmount: decimal(0),
          maxRevenueAmount: decimal(100),
          sortOrder: 0,
        },
      ]);
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.createBracket(
          'rrs-1',
          {
            label: 'Bậc chồng lấn',
            minRevenueAmount: 50,
            maxRevenueAmount: 150,
            commissionRatePercent: 1,
            rpmRatePer1000Views: 10,
          },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('accepts the highest bracket with maxRevenueAmount left unbounded', async () => {
      const prisma = makePrismaMock();
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-1',
        status: 'DRAFT',
      });
      prisma.revenueRewardBracket.findMany.mockResolvedValue([
        {
          label: 'Bậc 1',
          minRevenueAmount: decimal(0),
          maxRevenueAmount: decimal(100),
          sortOrder: 0,
        },
      ]);
      prisma.revenueRewardBracket.create.mockResolvedValue({ id: 'rrb-2' });
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await service.createBracket(
        'rrs-1',
        {
          label: 'Bậc cao nhất',
          minRevenueAmount: 100,
          commissionRatePercent: 1,
          rpmRatePer1000Views: 10,
        },
        'user-admin',
      );

      const createArg = (
        prisma.revenueRewardBracket.create.mock.calls[0] as [
          { data: { sortOrder: number } },
        ]
      )[0];
      expect(createArg.data.sortOrder).toBe(1);
    });
  });

  describe('updateBracket / deleteBracket', () => {
    it('rejects updating a bracket whose rule set is not DRAFT', async () => {
      const prisma = makePrismaMock();
      prisma.revenueRewardBracket.findUnique.mockResolvedValue({
        id: 'rrb-1',
        rewardRuleSetId: 'rrs-1',
        label: 'Bậc 1',
        minRevenueAmount: decimal(0),
        maxRevenueAmount: decimal(100),
      });
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-1',
        status: 'ACTIVE',
      });
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.updateBracket('rrb-1', { label: 'Đổi tên' }, 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects deleting a bracket whose rule set is not DRAFT', async () => {
      const prisma = makePrismaMock();
      prisma.revenueRewardBracket.findUnique.mockResolvedValue({
        id: 'rrb-1',
        rewardRuleSetId: 'rrs-1',
      });
      prisma.rewardRuleSet.findUnique.mockResolvedValue({
        id: 'rrs-1',
        status: 'ARCHIVED',
      });
      const service = new RewardRuleSetsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.deleteBracket('rrb-1', 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });
});
