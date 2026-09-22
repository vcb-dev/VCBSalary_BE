import { Prisma } from '@prisma/client';
import { RevenueService } from '../revenue.service';

function record(amount = '125000000') {
  return {
    id: 10,
    employeeId: 1,
    payrollPeriodId: 2,
    officialRevenueAmount: new Prisma.Decimal(amount),
    enteredByUserId: 'accountant-user',
    enteredAt: new Date('2026-09-05T02:00:00Z'),
    updatedByUserId: null,
    updatedAt: new Date('2026-09-05T02:00:00Z'),
    enteredBy: { id: 'accountant-user', fullName: 'Kế toán' },
    updatedBy: null,
  };
}

function snapshot(revenueRecords: ReturnType<typeof record>[] = []) {
  return {
    id: 20,
    employeeId: 1,
    payrollPeriodId: 2,
    employeeCodeSnapshot: 'NV-000001',
    employeeNameSnapshot: 'Nguyễn Minh Anh',
    jobTitleSnapshot: 'Content Creator',
    employeeGroupsSnapshot: ['CONTENT_CREATOR'],
    teamIdSnapshot: 3,
    teamCodeSnapshot: 'TEAM-A',
    teamNameSnapshot: 'Team Alpha',
    leaderEmployeeIdSnapshot: null,
    leaderNameSnapshot: null,
    managerEmployeeIdSnapshot: null,
    managerNameSnapshot: null,
    employmentStatusSnapshot: 'ACTIVE',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    employee: { revenueRecords },
  };
}

function makePrismaMock() {
  const mock = {
    payrollPeriod: {
      findUnique: jest.fn().mockResolvedValue({ id: 2, status: 'OPEN' }),
    },
    payrollPeriodEmployeeSnapshot: {
      findMany: jest.fn().mockResolvedValue([snapshot([record()])]),
      findUnique: jest.fn().mockResolvedValue(snapshot()),
      count: jest.fn().mockResolvedValue(1),
    },
    employeeRevenueRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(record()),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof mock) => unknown)(mock)
      : Promise.all(arg as Promise<unknown>[]),
  );
  return mock;
}

function makeAuthorizationMock(
  scope:
    { type: 'ALL' } | { type: 'TEAM'; teamIds: number[] } | { type: 'SELF' } = {
    type: 'ALL',
  },
  employeeId: number | null = null,
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

function firstCallArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0]?.[0] as T;
}

describe('RevenueService', () => {
  it('lists period snapshots in scope, including their official revenue', async () => {
    const prisma = makePrismaMock();
    const service = new RevenueService(
      prisma as never,
      makeAuthorizationMock() as never,
      makeAuditLogMock() as never,
    );

    const result = await service.list('admin-user', 2, {
      page: 1,
      pageSize: 20,
    });

    expect(result.meta.total).toBe(1);
    expect(result.data[0]).toMatchObject({
      employeeId: 1,
      employeeName: 'Nguyễn Minh Anh',
      officialRevenueAmount: '125000000',
      enteredBy: { id: 'accountant-user', fullName: 'Kế toán' },
    });
  });

  it('does not expose another employee revenue to a SELF-scoped user', async () => {
    const prisma = makePrismaMock();
    const service = new RevenueService(
      prisma as never,
      makeAuthorizationMock({ type: 'SELF' }, 99) as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.getForEmployee('employee-user', 2, 1),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
  });

  it('creates official revenue and its audit event in one transaction', async () => {
    const prisma = makePrismaMock();
    const auditLog = makeAuditLogMock();
    const service = new RevenueService(
      prisma as never,
      makeAuthorizationMock() as never,
      auditLog as never,
    );

    const result = await service.upsert('accountant-user', 2, 1, {
      officialRevenueAmount: '125000000',
    });

    const upsert = firstCallArg<{
      create: {
        employeeId: number;
        payrollPeriodId: number;
        enteredByUserId: string;
      };
    }>(prisma.employeeRevenueRecord.upsert);
    expect(upsert.create).toMatchObject({
      employeeId: 1,
      payrollPeriodId: 2,
      enteredByUserId: 'accountant-user',
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        action: 'REVENUE_CREATED',
        targetEmployeeId: 1,
        payrollPeriodId: 2,
      }),
    );
    expect(result.officialRevenueAmount).toBe('125000000');
  });

  it('updates existing revenue and records before/after audit values', async () => {
    const prisma = makePrismaMock();
    prisma.employeeRevenueRecord.findUnique.mockResolvedValue(record('100'));
    prisma.employeeRevenueRecord.upsert.mockResolvedValue(record('120'));
    const auditLog = makeAuditLogMock();
    const service = new RevenueService(
      prisma as never,
      makeAuthorizationMock() as never,
      auditLog as never,
    );

    await service.upsert('accountant-user', 2, 1, {
      officialRevenueAmount: '120',
    });

    expect(auditLog.record).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        action: 'REVENUE_UPDATED',
        beforeData: { officialRevenueAmount: '100' },
        afterData: { officialRevenueAmount: '120' },
      }),
    );
  });

  it('rejects revenue changes after the payroll period is closed', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 2,
      status: 'CLOSED',
    });
    const service = new RevenueService(
      prisma as never,
      makeAuthorizationMock() as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.upsert('accountant-user', 2, 1, {
        officialRevenueAmount: '100',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.employeeRevenueRecord.upsert).not.toHaveBeenCalled();
  });

  it('rejects employees that are not part of the period snapshot', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriodEmployeeSnapshot.findUnique.mockResolvedValue(null);
    const service = new RevenueService(
      prisma as never,
      makeAuthorizationMock() as never,
      makeAuditLogMock() as never,
    );

    await expect(
      service.upsert('accountant-user', 2, 1, {
        officialRevenueAmount: '100',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
