import { KpiAssignmentsService } from '../kpi-assignments.service';

interface PrismaMock {
  payrollPeriod: { findUnique: jest.Mock };
  kpiGroup: { findUnique: jest.Mock };
  payrollPeriodEmployeeSnapshot: { findUnique: jest.Mock; findMany: jest.Mock };
  payrollPeriodEmployeeTeamSnapshot: {
    findUnique: jest.Mock;
    count: jest.Mock;
  };
  employeeKpiAssignment: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  employeeKpiActual: { createMany: jest.Mock };
  $transaction: jest.Mock;
}

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    payrollPeriod: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', status: 'OPEN' }),
    },
    kpiGroup: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'g1', isActive: true, items: [] }),
    },
    payrollPeriodEmployeeSnapshot: {
      findUnique: jest.fn().mockResolvedValue({
        payrollPeriodId: 'p1',
        employeeId: 'e1',
        teamIdSnapshot: 'team-1',
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    payrollPeriodEmployeeTeamSnapshot: {
      findUnique: jest.fn().mockResolvedValue({
        payrollPeriodId: 'p1',
        employeeId: 'e1',
        teamId: 'team-1',
      }),
      count: jest.fn().mockResolvedValue(1),
    },
    employeeKpiAssignment: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    employeeKpiActual: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
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
    | { type: 'NONE' } = {
    type: 'ALL',
  },
) {
  return {
    resolveScope: jest.fn().mockResolvedValue(scope),
    resolvePermissionScope: jest.fn().mockResolvedValue(scope),
    getEmployeeId: jest.fn().mockResolvedValue(null),
  };
}

function makeAuditLogMock() {
  return { record: jest.fn().mockResolvedValue({}) };
}

describe('KpiAssignmentsService', () => {
  describe('create', () => {
    it('rejects an unknown payroll period', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue(null);
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', 'unknown', {
          employeeId: 'e1',
          kpiGroupId: 'g1',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects when the period is already CLOSED', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'CLOSED',
      });
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', 'p1', {
          employeeId: 'e1',
          kpiGroupId: 'g1',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an unknown kpi group', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue(null);
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', 'p1', {
          employeeId: 'e1',
          kpiGroupId: 'unknown',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects an inactive kpi group', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 'g1',
        isActive: false,
        items: [],
      });
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', 'p1', {
          employeeId: 'e1',
          kpiGroupId: 'g1',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an employee without a snapshot in this period', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue(null);
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', 'p1', {
          employeeId: 'e1',
          kpiGroupId: 'g1',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects assigning a group that is not configured for the employee team', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 'g1',
        isActive: true,
        items: [],
        teams: [{ id: 'team-content' }],
      });
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        payrollPeriodId: 'p1',
        employeeId: 'e1',
        teamIdSnapshot: 'team-editor',
      });
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', 'p1', {
          employeeId: 'e1',
          kpiGroupId: 'g1',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an employee outside the leader team scope', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
        payrollPeriodId: 'p1',
        employeeId: 'e1',
        teamIdSnapshot: 'team-other',
      });
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock({
          type: 'TEAM',
          teamIds: ['team-mine'],
        }) as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-leader', 'p1', {
          employeeId: 'e1',
          kpiGroupId: 'g1',
        }),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    });

    it('rejects a duplicate ASSIGNED assignment', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findUnique.mockResolvedValue({
        id: 'a1',
        assignmentStatus: 'ASSIGNED',
      });
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create('user-admin', 'p1', {
          employeeId: 'e1',
          kpiGroupId: 'g1',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('creates the assignment and auto-creates actual rows for active items', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 'g1',
        isActive: true,
        items: [{ id: 'item-1' }, { id: 'item-2' }],
      });
      prisma.employeeKpiAssignment.create.mockResolvedValue({
        id: 'a1',
        employeeId: 'e1',
        kpiGroupId: 'g1',
        payrollPeriodId: 'p1',
      });
      const auditLog = makeAuditLogMock();
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        auditLog as never,
      );

      await service.create('user-admin', 'p1', {
        employeeId: 'e1',
        kpiGroupId: 'g1',
      });

      const createManyArg = (
        prisma.employeeKpiActual.createMany.mock.calls[0] as [
          { data: { employeeId: string; kpiItemId: string }[] },
        ]
      )[0];
      expect(createManyArg.data).toHaveLength(2);
      expect(createManyArg.data[0].employeeId).toBe('e1');
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'KPI_ASSIGNMENT_CREATED' }),
      );
    });

    it('reactivates a previously CANCELLED assignment instead of duplicating it', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findUnique.mockResolvedValue({
        id: 'a1',
        assignmentStatus: 'CANCELLED',
      });
      prisma.employeeKpiAssignment.update.mockResolvedValue({
        id: 'a1',
        assignmentStatus: 'ASSIGNED',
      });
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await service.create('user-admin', 'p1', {
        employeeId: 'e1',
        kpiGroupId: 'g1',
      });

      expect(prisma.employeeKpiAssignment.create).not.toHaveBeenCalled();
      const updateArg = (
        prisma.employeeKpiAssignment.update.mock.calls[0] as [
          { where: { id: string }; data: { assignmentStatus: string } },
        ]
      )[0];
      expect(updateArg.where).toEqual({ id: 'a1' });
      expect(updateArg.data.assignmentStatus).toBe('ASSIGNED');
    });

    it('assigns the same kpi group again for a second team in the same period', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 'g1',
        isActive: true,
        items: [{ id: 'item-1' }],
      });
      // Nhân sự đã được gán g1 ở team-1; lượt gán cho team-2 phải tra theo khóa có teamId
      // nên vẫn thấy "chưa tồn tại" và tạo được dòng riêng cho team-2.
      prisma.payrollPeriodEmployeeTeamSnapshot.findUnique.mockResolvedValue({
        payrollPeriodId: 'p1',
        employeeId: 'e1',
        teamId: 'team-2',
      });
      prisma.employeeKpiAssignment.create.mockResolvedValue({
        id: 'a2',
        employeeId: 'e1',
        teamId: 'team-2',
        kpiGroupId: 'g1',
        payrollPeriodId: 'p1',
      });
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await service.create('user-admin', 'p1', {
        employeeId: 'e1',
        kpiGroupId: 'g1',
        teamId: 'team-2',
      });

      const findUniqueArg = (
        prisma.employeeKpiAssignment.findUnique.mock.calls[0] as [
          { where: Record<string, unknown> },
        ]
      )[0];
      expect(findUniqueArg.where).toEqual({
        employeeId_teamId_kpiGroupId_payrollPeriodId: {
          employeeId: 'e1',
          teamId: 'team-2',
          kpiGroupId: 'g1',
          payrollPeriodId: 'p1',
        },
      });

      const createArg = (
        prisma.employeeKpiAssignment.create.mock.calls[0] as [
          { data: { teamId: string } },
        ]
      )[0];
      expect(createArg.data.teamId).toBe('team-2');

      const createManyArg = (
        prisma.employeeKpiActual.createMany.mock.calls[0] as [
          { data: { teamId: string }[] },
        ]
      )[0];
      expect(createManyArg.data[0].teamId).toBe('team-2');
    });
  });

  describe('cancel', () => {
    it('rejects an unknown assignment', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findUnique.mockResolvedValue(null);
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.cancel('user-admin', 'p1', 'unknown'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('soft-cancels and records an audit entry', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findUnique.mockResolvedValue({
        id: 'a1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        assignmentStatus: 'ASSIGNED',
      });
      const auditLog = makeAuditLogMock();
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        auditLog as never,
      );

      await service.cancel('user-admin', 'p1', 'a1');

      const updateArg = (
        prisma.employeeKpiAssignment.update.mock.calls[0] as [
          { where: { id: string }; data: { assignmentStatus: string } },
        ]
      )[0];
      expect(updateArg.data.assignmentStatus).toBe('CANCELLED');
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'KPI_ASSIGNMENT_CANCELLED' }),
      );
    });

    it('is idempotent when already CANCELLED', async () => {
      const prisma = makePrismaMock();
      prisma.employeeKpiAssignment.findUnique.mockResolvedValue({
        id: 'a1',
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        assignmentStatus: 'CANCELLED',
      });
      const service = new KpiAssignmentsService(
        prisma as never,
        makeAuthorizationMock() as never,
        makeAuditLogMock() as never,
      );

      await service.cancel('user-admin', 'p1', 'a1');

      expect(prisma.employeeKpiAssignment.update).not.toHaveBeenCalled();
    });
  });
});
