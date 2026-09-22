import { EmployeeKpiTargetsService } from '../kpi-employee-targets.service';

interface PrismaMock {
  payrollPeriod: { findUnique: jest.Mock };
  payrollPeriodEmployeeSnapshot: { findUnique: jest.Mock };
  kpiItem: { findUnique: jest.Mock };
  employeeKpiAssignment: { findUnique: jest.Mock; findMany: jest.Mock };
  employeeKpiTarget: { findUnique: jest.Mock; upsert: jest.Mock };
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
    payrollPeriodEmployeeSnapshot: {
      findUnique: jest.fn().mockResolvedValue({
        employeeId: 'e1',
        payrollPeriodId: 'p1',
        teamIdSnapshot: 'team-1',
      }),
    },
    kpiItem: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'item-1', kpiGroupId: 'group-1' }),
    },
    employeeKpiAssignment: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'assignment-1',
        assignmentStatus: 'ASSIGNED',
      }),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'assignment-1',
          teamId: 'team-1',
          assignmentStatus: 'ASSIGNED',
        },
      ]),
    },
    employeeKpiTarget: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'target-1' }),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: PrismaMock) => unknown)(mock)
      : Promise.all(arg as Promise<unknown>[]),
  );
  return mock;
}

function makeAuthorizationMock(
  scope:
    { type: 'ALL' } | { type: 'TEAM'; teamIds: string[] } | { type: 'SELF' } = {
    type: 'TEAM',
    teamIds: ['team-1'],
  },
) {
  return {
    resolveScope: jest.fn().mockResolvedValue(scope),
    resolvePermissionScope: jest.fn().mockResolvedValue(scope),
  };
}

function makeAuditLogMock() {
  return { record: jest.fn().mockResolvedValue({}) };
}

function firstCallArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0]?.[0] as T;
}

describe('EmployeeKpiTargetsService', () => {
  it('creates a target for an employee within the leader team and records the audit event', async () => {
    const prisma = makePrismaMock();
    const auditLog = makeAuditLogMock();
    const service = new EmployeeKpiTargetsService(
      prisma as never,
      makeAuthorizationMock() as never,
      auditLog as never,
    );

    await service.setTarget('leader-user', 'p1', 'e1', 'item-1', {
      targetValue: 120,
    });

    const upsert = firstCallArg<{
      create: { employeeId: string; targetValue: number };
    }>(prisma.employeeKpiTarget.upsert);
    expect(upsert.create).toMatchObject({ employeeId: 'e1', targetValue: 120 });
    expect(auditLog.record).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        action: 'EMPLOYEE_KPI_TARGET_CREATED',
        targetEmployeeId: 'e1',
      }),
    );
  });

  it('does not allow a SELF-scoped user to set an employee target', async () => {
    const prisma = makePrismaMock();
    const service = new EmployeeKpiTargetsService(
      prisma as never,
      makeAuthorizationMock({ type: 'SELF' }) as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.setTarget('employee-user', 'p1', 'e1', 'item-1', {
        targetValue: 120,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.employeeKpiTarget.upsert).not.toHaveBeenCalled();
  });

  it('does not allow a leader to set a target outside their team scope', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue({
      employeeId: 'e1',
      payrollPeriodId: 'p1',
      teamIdSnapshot: 'other-team',
    });
    const service = new EmployeeKpiTargetsService(
      prisma as never,
      makeAuthorizationMock({ type: 'TEAM', teamIds: ['team-1'] }) as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.setTarget('leader-user', 'p1', 'e1', 'item-1', {
        targetValue: 120,
      }),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
  });

  it('rejects target changes after a payroll period is closed', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 'p1',
      status: 'CLOSED',
    });
    const service = new EmployeeKpiTargetsService(
      prisma as never,
      makeAuthorizationMock() as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.setTarget('leader-user', 'p1', 'e1', 'item-1', {
        targetValue: 120,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('updates an existing target idempotently and records an update audit event', async () => {
    const prisma = makePrismaMock();
    prisma.employeeKpiTarget.findUnique.mockResolvedValue({
      id: 'target-1',
      targetValue: decimal(100),
    });
    const auditLog = makeAuditLogMock();
    const service = new EmployeeKpiTargetsService(
      prisma as never,
      makeAuthorizationMock({ type: 'ALL' }) as never,
      auditLog as never,
    );

    await service.setTarget('admin-user', 'p1', 'e1', 'item-1', {
      targetValue: 120,
    });

    expect(auditLog.record).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: 'EMPLOYEE_KPI_TARGET_UPDATED' }),
    );
  });
});
