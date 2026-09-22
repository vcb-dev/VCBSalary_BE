import { KpiOkrProposalsService } from '../kpi-okr-proposals.service';

interface PrismaMock {
  payrollPeriod: { findUnique: jest.Mock };
  payrollPeriodEmployeeSnapshot: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  kpiGroup: { findUnique: jest.Mock };
  kpiOkrProposal: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  employeeOkr: { create: jest.Mock };
  $transaction: jest.Mock;
}

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    payrollPeriod: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', status: 'OPEN' }),
    },
    payrollPeriodEmployeeSnapshot: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ payrollPeriodId: 'p1', employeeId: 'e1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    kpiGroup: {
      findUnique: jest.fn().mockResolvedValue({ id: 'g1' }),
    },
    kpiOkrProposal: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    employeeOkr: {
      create: jest.fn().mockResolvedValue({ id: 'okr-1' }),
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

function makeAuthorizationMock(
  scope:
    | { type: 'ALL' }
    | { type: 'TEAM'; teamIds: string[] }
    | { type: 'SELF' }
    | { type: 'NONE' } = { type: 'ALL' },
  employeeId: string | null = 'e1',
) {
  return {
    resolveScope: jest.fn().mockResolvedValue(scope),
    resolvePermissionScope: jest.fn().mockResolvedValue(scope),
    getEmployeeId: jest.fn().mockResolvedValue(employeeId),
  };
}

function makeAuditLogMock() {
  return { record: jest.fn().mockResolvedValue({}) };
}

describe('KpiOkrProposalsService', () => {
  describe('create', () => {
    it('rejects a KPI_ITEM proposal without proposedKpiGroupId', async () => {
      const prisma = makePrismaMock();
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-e1', {
          payrollPeriodId: 'p1',
          proposalType: 'KPI_ITEM',
          proposedName: 'Video B',
          proposedTargetValue: 10,
          reason: 'Cần thêm KPI',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an OKR proposal that sets proposedKpiGroupId', async () => {
      const prisma = makePrismaMock();
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-e1', {
          payrollPeriodId: 'p1',
          proposalType: 'OKR',
          proposedKpiGroupId: 'g1',
          proposedName: 'Tăng retention',
          proposedTargetValue: 60,
          proposedRewardAmount: 500000,
          reason: 'Đề xuất OKR',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an OKR proposal without proposedRewardAmount', async () => {
      const prisma = makePrismaMock();
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-e1', {
          payrollPeriodId: 'p1',
          proposalType: 'OKR',
          proposedName: 'Tăng retention',
          proposedTargetValue: 60,
          reason: 'Đề xuất OKR',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects when the actor account has no linked employee', async () => {
      const prisma = makePrismaMock();
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }, null) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', {
          payrollPeriodId: 'p1',
          proposalType: 'KPI_ITEM',
          proposedKpiGroupId: 'g1',
          proposedName: 'Video B',
          proposedTargetValue: 10,
          reason: 'Cần thêm KPI',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('creates the proposal and records an audit entry', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.create.mockResolvedValue({ id: 'proposal-1' });
      const auditLog = makeAuditLogMock();
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock() as never,
        auditLog as never,
      );

      await service.create('user-e1', {
        payrollPeriodId: 'p1',
        proposalType: 'KPI_ITEM',
        proposedKpiGroupId: 'g1',
        proposedName: 'Video B',
        proposedTargetValue: 10,
        reason: 'Cần thêm KPI',
      });

      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'PROPOSAL_CREATED' }),
      );
    });
  });

  describe('approve', () => {
    it('rejects approving a proposal that is not PENDING (idempotent — no double creation)', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.findUnique.mockResolvedValue({
        id: 'proposal-1',
        status: 'APPROVED',
        proposalType: 'OKR',
        proposerEmployeeId: 'e1',
        payrollPeriodId: 'p1',
      });
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.approve('user-leader', 'proposal-1'),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(prisma.employeeOkr.create).not.toHaveBeenCalled();
    });

    it('approving an OKR proposal creates an EmployeeOkr and records the result entity', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.findUnique.mockResolvedValue({
        id: 'proposal-1',
        status: 'PENDING',
        proposalType: 'OKR',
        proposerEmployeeId: 'e1',
        payrollPeriodId: 'p1',
        proposedName: 'Tăng retention',
        proposedUnit: '%',
        proposedTargetValue: 60,
        proposedRewardAmount: 500000,
        proposedDeadline: null,
      });
      prisma.kpiOkrProposal.update.mockResolvedValue({
        id: 'proposal-1',
        status: 'APPROVED',
      });
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }) as never,
        makeAuditLogMock() as never,
      );

      await service.approve('user-admin', 'proposal-1');

      const createArg = (
        prisma.employeeOkr.create.mock.calls[0] as [
          { data: { employeeId: string; title: string } },
        ]
      )[0];
      expect(createArg.data.employeeId).toBe('e1');
      expect(createArg.data.title).toBe('Tăng retention');

      const updateArg = (
        prisma.kpiOkrProposal.update.mock.calls[0] as [
          {
            data: {
              resultEntityType: string | null;
              resultEntityId: string | null;
            };
          },
        ]
      )[0];
      expect(updateArg.data.resultEntityType).toBe('EmployeeOkr');
      expect(updateArg.data.resultEntityId).toBe('okr-1');
    });

    it('approving a KPI_ITEM proposal only flips status, does not auto-create a KpiItem', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.findUnique.mockResolvedValue({
        id: 'proposal-1',
        status: 'PENDING',
        proposalType: 'KPI_ITEM',
        proposerEmployeeId: 'e1',
        payrollPeriodId: 'p1',
        proposedKpiGroupId: 'g1',
        proposedName: 'Video B',
      });
      prisma.kpiOkrProposal.update.mockResolvedValue({
        id: 'proposal-1',
        status: 'APPROVED',
      });
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }) as never,
        makeAuditLogMock() as never,
      );

      await service.approve('user-admin', 'proposal-1');

      expect(prisma.employeeOkr.create).not.toHaveBeenCalled();
      const updateArg = (
        prisma.kpiOkrProposal.update.mock.calls[0] as [
          {
            data: {
              resultEntityType: string | null;
              resultEntityId: string | null;
            };
          },
        ]
      )[0];
      expect(updateArg.data.resultEntityType).toBeNull();
      expect(updateArg.data.resultEntityId).toBeNull();
    });

    it('does not create an OKR when another request already claimed the proposal', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.findUnique.mockResolvedValue({
        id: 'proposal-1',
        status: 'PENDING',
        proposalType: 'OKR',
        proposerEmployeeId: 'e1',
        payrollPeriodId: 'p1',
        proposedRewardAmount: 500000,
      });
      prisma.kpiOkrProposal.updateMany.mockResolvedValue({ count: 0 });
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.approve('user-admin', 'proposal-1'),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(prisma.employeeOkr.create).not.toHaveBeenCalled();
    });

    it('rejects a reviewer outside the proposer team scope', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.findUnique.mockResolvedValue({
        id: 'proposal-1',
        status: 'PENDING',
        proposalType: 'OKR',
        proposerEmployeeId: 'e1',
        payrollPeriodId: 'p1',
      });
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-other',
      });
      prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([]);
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.approve('user-leader', 'proposal-1'),
      ).rejects.toMatchObject({
        code: 'OUT_OF_SCOPE',
      });
    });
  });

  describe('reject', () => {
    it('sets status REJECTED with the given reason', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.findUnique.mockResolvedValue({
        id: 'proposal-1',
        status: 'PENDING',
        proposalType: 'KPI_ITEM',
        proposerEmployeeId: 'e1',
        payrollPeriodId: 'p1',
      });
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock({ type: 'ALL' }) as never,
        makeAuditLogMock() as never,
      );

      await service.reject('user-admin', 'proposal-1', {
        reason: 'Không phù hợp',
      });

      const updateArg = (
        prisma.kpiOkrProposal.update.mock.calls[0] as [
          { data: { status: string; rejectionReason: string } },
        ]
      )[0];
      expect(updateArg.data.status).toBe('REJECTED');
      expect(updateArg.data.rejectionReason).toBe('Không phù hợp');
    });
  });

  describe('list — visibility', () => {
    it('always includes proposals created by the actor themselves, even outside team scope', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.findMany.mockResolvedValue([
        {
          id: 'proposal-1',
          proposalType: 'OKR',
          proposerEmployeeId: 'e1',
          payrollPeriodId: 'p1',
        },
      ]);
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock({ type: 'SELF' }, 'e1') as never,
        makeAuditLogMock() as never,
      );

      const result = await service.list('user-e1');

      expect(result).toHaveLength(1);
    });

    it('hides proposals from employees outside the reviewer team scope', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.findMany.mockResolvedValue([
        {
          id: 'proposal-1',
          proposalType: 'OKR',
          proposerEmployeeId: 'e1',
          payrollPeriodId: 'p1',
        },
      ]);
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        teamIdSnapshot: 'team-other',
      });
      const service = new KpiOkrProposalsService(
        prisma as never,
        makeAuthorizationMock(
          { type: 'TEAM', teamIds: ['team-mine'] },
          'leader-1',
        ) as never,
        makeAuditLogMock() as never,
      );

      const result = await service.list('user-leader');

      expect(result).toHaveLength(0);
      expect(
        prisma.payrollPeriodEmployeeSnapshot.findUnique,
      ).not.toHaveBeenCalled();
      expect(
        prisma.payrollPeriodEmployeeSnapshot.findMany,
      ).toHaveBeenCalledTimes(1);
    });

    it('applies KPI and OKR team scopes independently for the same employee snapshot', async () => {
      const prisma = makePrismaMock();
      prisma.kpiOkrProposal.findMany.mockResolvedValue([
        {
          id: 'proposal-kpi',
          proposalType: 'KPI_ITEM',
          proposerEmployeeId: 'e1',
          payrollPeriodId: 'p1',
        },
        {
          id: 'proposal-okr',
          proposalType: 'OKR',
          proposerEmployeeId: 'e1',
          payrollPeriodId: 'p1',
        },
      ]);
      prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
        {
          payrollPeriodId: 'p1',
          employeeId: 'e1',
          teamIdSnapshot: 'team-kpi',
        },
      ]);
      const authorization = makeAuthorizationMock({ type: 'ALL' }, 'leader-1');
      authorization.resolveScope
        .mockResolvedValueOnce({ type: 'TEAM', teamIds: ['team-kpi'] })
        .mockResolvedValueOnce({ type: 'TEAM', teamIds: ['team-okr'] });
      const service = new KpiOkrProposalsService(
        prisma as never,
        authorization as never,
        makeAuditLogMock() as never,
      );

      const result = await service.list('user-leader');

      expect(result.map((proposal) => proposal.id)).toEqual(['proposal-kpi']);
    });
  });
});
