import { TaskComplianceService } from '../task-compliance.service';

const SOURCE_RESPONSE = {
  contract_version: '1.0',
  generated_at: '2026-10-02T03:00:00.000Z',
  timezone: 'Asia/Ho_Chi_Minh',
  range: { from: '2026-09-01', to: '2026-09-30' },
  team: { id: 'external-team', name: 'Content' },
  filters: { user_id: 'external-user' },
  coverage: {
    snapshot_count: 30,
    evaluated_from: '2026-09-01',
    evaluated_through: '2026-09-30',
  },
  summary: {
    expected: 60,
    completed_on_time: 55,
    missing: 5,
    affected_days: 3,
    affected_records: 3,
  },
  records: [],
  pagination: { page: 1, limit: 20, total: 0, total_pages: 0 },
  warnings: [],
};

function makePrisma() {
  return {
    payrollPeriod: {
      findUnique: jest.fn().mockResolvedValue({
        id: 8,
        startDate: new Date('2026-09-01T00:00:00.000Z'),
        endDate: new Date('2026-09-30T00:00:00.000Z'),
      }),
    },
    employee: {
      findUnique: jest.fn().mockResolvedValue({
        id: 21,
        externalId: null,
        sourceSystem: null,
      }),
    },
    externalEmployeeIdentity: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ externalUserId: 'external-user' }),
    },
    payrollPeriodEmployeeTeamSnapshot: {
      findFirst: jest.fn().mockResolvedValue({
        teamId: 4,
        isPrimary: true,
        team: { id: 4, name: 'Content', externalId: 'external-team' },
      }),
    },
  };
}

function makeAuthorization(scope: object = { type: 'ALL' }) {
  return {
    resolveScope: jest.fn().mockResolvedValue(scope),
    getEmployeeId: jest.fn().mockResolvedValue(null),
  };
}

function makePeriodScope(inScope = true) {
  return {
    includesEmployee: jest.fn().mockResolvedValue(inScope),
    includesEmployeeTeam: jest.fn().mockResolvedValue(inScope),
  };
}

function makeClient() {
  return {
    fetchTaskComplianceForPayrollSync: jest
      .fn()
      .mockResolvedValue(SOURCE_RESPONSE),
  };
}

describe('TaskComplianceService', () => {
  it('resolves the period links and forwards a scoped payroll query to VCBI', async () => {
    const prisma = makePrisma();
    const client = makeClient();
    const service = new TaskComplianceService(
      prisma as never,
      makeAuthorization() as never,
      makePeriodScope() as never,
      client as never,
    );

    const result = await service.getForEmployee('user-1', 8, 21, {
      page: 2,
      pageSize: 10,
    });

    expect(client.fetchTaskComplianceForPayrollSync).toHaveBeenCalledWith(
      'external-team',
      {
        dateFrom: '2026-09-01',
        dateTo: '2026-09-30',
        externalUserId: 'external-user',
        page: 2,
        limit: 10,
      },
    );
    expect(result.local_context).toEqual({
      payroll_period_id: 8,
      employee_id: 21,
      team_id: 4,
      team_name: 'Content',
    });
  });

  it('checks the exact team when teamId is supplied', async () => {
    const prisma = makePrisma();
    const periodScope = makePeriodScope();
    const service = new TaskComplianceService(
      prisma as never,
      makeAuthorization({ type: 'TEAM', teamIds: [4] }) as never,
      periodScope as never,
      makeClient() as never,
    );

    await service.getForEmployee('leader-1', 8, 21, {
      teamId: 4,
      page: 1,
      pageSize: 20,
    });

    expect(periodScope.includesEmployeeTeam).toHaveBeenCalledWith(
      { type: 'TEAM', teamIds: [4] },
      8,
      21,
      4,
      null,
    );
    expect(
      prisma.payrollPeriodEmployeeTeamSnapshot.findFirst,
    ).toHaveBeenCalledWith({
      where: { payrollPeriodId: 8, employeeId: 21, teamId: 4 },
      select: {
        teamId: true,
        isPrimary: true,
        team: { select: { id: true, name: true, externalId: true } },
      },
      orderBy: [{ isPrimary: 'desc' }, { teamId: 'asc' }],
    });
  });

  it('rejects employees outside the actor scope before calling VCBI', async () => {
    const client = makeClient();
    const service = new TaskComplianceService(
      makePrisma() as never,
      makeAuthorization({ type: 'NONE' }) as never,
      makePeriodScope(false) as never,
      client as never,
    );

    await expect(
      service.getForEmployee('user-1', 8, 21, { page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    expect(client.fetchTaskComplianceForPayrollSync).not.toHaveBeenCalled();
  });

  it('reports a missing employee link without calling VCBI', async () => {
    const prisma = makePrisma();
    prisma.externalEmployeeIdentity.findFirst.mockResolvedValue(null);
    const client = makeClient();
    const service = new TaskComplianceService(
      prisma as never,
      makeAuthorization() as never,
      makePeriodScope() as never,
      client as never,
    );

    await expect(
      service.getForEmployee('user-1', 8, 21, { page: 1, pageSize: 20 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(client.fetchTaskComplianceForPayrollSync).not.toHaveBeenCalled();
  });
});
