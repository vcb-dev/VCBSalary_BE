/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { AuditQueryService } from '../audit-query.service';
import { AUDITED_ACTIONS } from '../audit-policy';

function makePrismaMock() {
  const mock = {
    auditLog: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(),
    },
    team: { findMany: jest.fn().mockResolvedValue([]) },
    employee: { findMany: jest.fn().mockResolvedValue([]) },
    employeeGroup: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
  return mock;
}

function makeAuthorizationMock() {
  return {
    resolveScope: jest.fn().mockResolvedValue({ type: 'ALL' }),
    getEmployeeId: jest.fn().mockResolvedValue(null),
    hasPermission: jest.fn().mockResolvedValue(true),
  };
}

describe('AuditQueryService', () => {
  it('SELF scope only includes logs performed by or targeting the current user', async () => {
    const prisma = makePrismaMock();
    const authorization = makeAuthorizationMock();
    authorization.resolveScope.mockResolvedValue({ type: 'SELF' });
    authorization.getEmployeeId.mockResolvedValue(7);
    const service = new AuditQueryService(
      prisma as never,
      authorization as never,
    );

    await service.list('user-1', { page: 1, pageSize: 20 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { OR: [{ actorUserId: 'user-1' }, { targetEmployeeId: 7 }] },
          ]),
        }),
      }),
    );
  });

  it('TEAM scope filters both target employee and actor employee by granted teams', async () => {
    const prisma = makePrismaMock();
    const authorization = makeAuthorizationMock();
    authorization.resolveScope.mockResolvedValue({
      type: 'TEAM',
      teamIds: [4],
    });
    const service = new AuditQueryService(
      prisma as never,
      authorization as never,
    );

    await service.list('leader-1', { page: 1, pageSize: 20 });

    const call = prisma.auditLog.findMany.mock.calls[0][0] as {
      where: { AND: Array<{ OR?: unknown[] }> };
    };
    expect(call.where.AND[0].OR).toEqual(
      expect.arrayContaining([
        { actorUserId: 'leader-1' },
        { targetTeamIdSnapshot: { in: [4] } },
        { actorTeamIdSnapshot: { in: [4] } },
      ]),
    );
  });

  it('requires report.export in addition to audit view before exporting CSV', async () => {
    const prisma = makePrismaMock();
    const authorization = makeAuthorizationMock();
    authorization.hasPermission.mockResolvedValue(false);
    const service = new AuditQueryService(
      prisma as never,
      authorization as never,
    );

    await expect(service.exportCsv('user-1', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('hides historical events outside the current audit policy', async () => {
    const prisma = makePrismaMock();
    const service = new AuditQueryService(
      prisma as never,
      makeAuthorizationMock() as never,
    );

    await service.list('user-1', { page: 1, pageSize: 20 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { action: { in: [...AUDITED_ACTIONS] } },
          ]),
        }),
      }),
    );
  });

  it('resolves employee relation names for a readable detail response', async () => {
    const prisma = makePrismaMock();
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 1,
      beforeData: {
        teamId: 2,
        leaderEmployeeId: 7,
        employeeGroupIds: [3],
      },
      afterData: {
        teamId: 4,
        managerEmployeeId: 8,
        employeeGroupIds: [5],
      },
    });
    prisma.team.findMany.mockResolvedValue([
      { id: 2, name: 'Team cũ' },
      { id: 4, name: 'Team mới' },
    ]);
    prisma.employee.findMany.mockResolvedValue([
      { id: 7, fullName: 'Leader A' },
      { id: 8, fullName: 'Manager B' },
    ]);
    prisma.employeeGroup.findMany.mockResolvedValue([
      { id: 3, name: 'Nhóm cũ' },
      { id: 5, name: 'Nhóm mới' },
    ]);
    const service = new AuditQueryService(
      prisma as never,
      makeAuthorizationMock() as never,
    );

    const result = await service.getOne('user-1', 1);

    expect(result.references).toEqual({
      teams: [
        { id: 2, name: 'Team cũ' },
        { id: 4, name: 'Team mới' },
      ],
      employees: [
        { id: 7, fullName: 'Leader A' },
        { id: 8, fullName: 'Manager B' },
      ],
      employeeGroups: [
        { id: 3, name: 'Nhóm cũ' },
        { id: 5, name: 'Nhóm mới' },
      ],
    });
  });
});
