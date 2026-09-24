import { KpiSyncService } from '../kpi-sync.service';
import { Prisma } from '@prisma/client';
import type { ResolvedScope } from '../../../../common/types/resolved-scope.types';

const TEAM_ID = '1ff66064-3404-415b-9ec5-a9d1cc89c348';
const USER_ID = '5f876967-bdf7-4ce9-a815-4eeb93ab1990';
const EMPTY_PERFORMANCE_GOALS = {
  contract_version: '2.0',
  month: '2026-08',
  team: { id: TEAM_ID, name: 'K2' },
  generated_at: '2026-08-31T00:00:00.000Z',
  records: [],
  warnings: [],
};

function makePrismaMock() {
  const mock = {
    payrollPeriod: { findUnique: jest.fn() },
    team: { findUnique: jest.fn(), findMany: jest.fn() },
    kpiSyncRun: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'run-id' }),
      update: jest.fn(),
    },
    employee: { findMany: jest.fn() },
    employeeTeamMembership: { findMany: jest.fn() },
    externalEmployeeIdentity: { upsert: jest.fn() },
    kpiGroup: { findMany: jest.fn(), upsert: jest.fn() },
    kpiItem: { upsert: jest.fn(), updateMany: jest.fn() },
    employeeKpiAssignment: { findMany: jest.fn(), upsert: jest.fn() },
    employeeKpiTarget: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    employeeKpiActual: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    employeeOkr: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    kpiSyncRunItem: {
      create: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation(
    (callback: (tx: typeof mock) => Promise<unknown>) => callback(mock),
  );
  mock.employeeTeamMembership.findMany.mockImplementation(async () => {
    const employees = (await mock.employee.findMany()) as Array<{
      id: number;
      externalId?: string | null;
      fullName?: string;
      user?: { email?: string | null } | null;
    }>;
    return employees.map((employee) => ({
      employee: {
        id: employee.id,
        fullName: employee.fullName ?? '',
        user: employee.user ?? null,
        externalIdentities: employee.externalId
          ? [
              {
                externalUserId: employee.externalId,
                lastKnownEmail: employee.user?.email ?? null,
              },
            ]
          : [],
      },
    }));
  });
  mock.externalEmployeeIdentity.upsert.mockImplementation(
    ({ create }: { create: { employeeId: number } }) =>
      Promise.resolve({ employeeId: create.employeeId }),
  );
  return mock;
}

function makeAuthorizationMock(scope: ResolvedScope = { type: 'ALL' }): {
  resolvePermissionScope: jest.Mock;
} {
  return { resolvePermissionScope: jest.fn().mockResolvedValue(scope) };
}

describe('KpiSyncService', () => {
  it('bỏ qua kỳ CLOSED và không gọi hệ thống nguồn', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 12,
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      status: 'CLOSED',
    });
    prisma.team.findUnique.mockResolvedValue({ id: 3, externalId: TEAM_ID });
    prisma.kpiSyncRun.update.mockResolvedValue({
      id: 'run-id',
      status: 'SKIPPED',
    });
    const client = {
      fetchKpisForPayrollSync: jest.fn(),
      fetchPerformanceGoalsForPayrollSync: jest.fn(),
    };
    const service = new KpiSyncService(
      prisma as never,
      client as never,
      { record: jest.fn() } as never,
      makeAuthorizationMock() as never,
    );

    const result = await service.sync(
      { externalTeamId: TEAM_ID, payrollPeriodId: 12 },
      USER_ID,
    );

    expect(result.status).toBe('SKIPPED');
    expect(client.fetchKpisForPayrollSync).not.toHaveBeenCalled();
    const updateCalls = prisma.kpiSyncRun.update.mock.calls as [
      { data: { status: string; errorSummary: string } },
    ][];
    expect(updateCalls[0][0].data.status).toBe('SKIPPED');
    expect(updateCalls[0][0].data.errorSummary).toContain('đã đóng');
  });

  it('yêu cầu đồng bộ cơ cấu tổ chức trước khi đồng bộ KPI', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 12,
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      status: 'OPEN',
    });
    prisma.team.findUnique.mockResolvedValue(null);
    const service = new KpiSyncService(
      prisma as never,
      {
        fetchKpisForPayrollSync: jest.fn(),
        fetchPerformanceGoalsForPayrollSync: jest.fn(),
      } as never,
      { record: jest.fn() } as never,
      makeAuthorizationMock() as never,
    );

    await expect(
      service.sync({ externalTeamId: TEAM_ID, payrollPeriodId: 12 }, USER_ID),
    ).rejects.toThrow('đồng bộ cơ cấu tổ chức trước');
    expect(prisma.kpiSyncRun.create).not.toHaveBeenCalled();
  });

  it('bỏ qua target/actual null và đánh dấu cả hai để nhập tay', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 12,
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      status: 'OPEN',
    });
    prisma.team.findUnique.mockResolvedValue({ id: 3, externalId: TEAM_ID });
    prisma.employee.findMany.mockResolvedValue([
      { id: 9, externalId: USER_ID },
    ]);
    prisma.kpiGroup.findMany.mockResolvedValue([
      {
        id: 7,
        code: 'CONTENT',
        items: [{ id: 21, code: 'CONTENT_NEW' }],
      },
    ]);
    prisma.employeeKpiAssignment.findMany.mockResolvedValue([
      { employeeId: 9, kpiGroupId: 7 },
    ]);
    prisma.employeeKpiTarget.findUnique.mockResolvedValue(null);
    prisma.employeeKpiActual.findUnique.mockResolvedValue(null);
    prisma.employeeKpiActual.create.mockResolvedValue({
      id: 31,
      actualValue: { toString: () => '0' },
      dataSource: 'MANUAL',
      manualEnteredAt: null,
      selfConfirmationStatus: 'DRAFT',
      leaderReviewStatus: 'PENDING',
    });
    prisma.kpiSyncRunItem.groupBy.mockResolvedValue([
      { resultStatus: 'SKIPPED', _count: 2 },
    ]);
    prisma.kpiSyncRunItem.count.mockResolvedValue(2);
    prisma.kpiSyncRun.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'run-id', ...data }),
    );
    const client = {
      fetchTeamForPayrollSync: jest.fn(),
      fetchPerformanceGoalsForPayrollSync: jest
        .fn()
        .mockResolvedValue(EMPTY_PERFORMANCE_GOALS),
      fetchKpisForPayrollSync: jest.fn().mockResolvedValue({
        contract_version: '1.0',
        month: '2026-08',
        team: { id: TEAM_ID, name: 'K2' },
        generated_at: new Date().toISOString(),
        records: [
          {
            user_id: USER_ID,
            employee_id: 'SOURCE-CODE-DIFFERENT-FROM-VCBI',
            group_code: 'CONTENT',
            metric_code: 'CONTENT_NEW',
            target: null,
            actual: null,
          },
        ],
        warnings: [],
      }),
    };
    const service = new KpiSyncService(
      prisma as never,
      client as never,
      { record: jest.fn() } as never,
      makeAuthorizationMock() as never,
    );

    const result = await service.sync(
      { externalTeamId: TEAM_ID, payrollPeriodId: 12 },
      USER_ID,
    );

    expect(result.status).toBe('SKIPPED');
    expect(result.manualEntryCount).toBe(2);
    expect(client.fetchTeamForPayrollSync).not.toHaveBeenCalled();
    expect(prisma.kpiSyncRunItem.create).toHaveBeenCalledTimes(2);
    const itemCalls = prisma.kpiSyncRunItem.create.mock.calls as [
      { data: { manualEntryRequired: boolean; resultStatus: string } },
    ][];
    for (const [input] of itemCalls) {
      expect(input.data.manualEntryRequired).toBe(true);
      expect(input.data.resultStatus).toBe('SKIPPED');
    }
  });

  it('đồng bộ cập nhật mục tiêu gốc nhưng giữ phần điều chỉnh và mục tiêu áp dụng', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 12,
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      status: 'OPEN',
    });
    prisma.team.findUnique.mockResolvedValue({ id: 3, externalId: TEAM_ID });
    prisma.employee.findMany.mockResolvedValue([
      { id: 9, externalId: USER_ID },
    ]);
    prisma.kpiGroup.findMany.mockResolvedValue([
      { id: 7, code: 'CONTENT', items: [{ id: 21, code: 'CONTENT_NEW' }] },
    ]);
    prisma.employeeKpiAssignment.findMany.mockResolvedValue([
      { employeeId: 9, kpiGroupId: 7 },
    ]);
    prisma.employeeKpiTarget.findMany.mockResolvedValue([
      {
        id: 20,
        employeeId: 9,
        kpiItemId: 21,
        targetValue: new Prisma.Decimal(100),
        overrideValue: new Prisma.Decimal(80),
      },
    ]);
    prisma.employeeKpiTarget.upsert.mockResolvedValue({
      id: 20,
      targetValue: new Prisma.Decimal(150),
      overrideValue: new Prisma.Decimal(80),
    });
    prisma.employeeKpiActual.findUnique.mockResolvedValue(null);
    prisma.employeeKpiActual.create.mockResolvedValue({
      id: 31,
      selfConfirmationStatus: 'DRAFT',
    });
    prisma.kpiSyncRunItem.groupBy.mockResolvedValue([
      { resultStatus: 'SUCCESS', _count: 1 },
      { resultStatus: 'SKIPPED', _count: 1 },
    ]);
    prisma.kpiSyncRunItem.count.mockResolvedValue(1);
    prisma.kpiSyncRun.update.mockResolvedValue({ id: 'run-id' });
    const client = {
      fetchTeamForPayrollSync: jest.fn(),
      fetchPerformanceGoalsForPayrollSync: jest
        .fn()
        .mockResolvedValue(EMPTY_PERFORMANCE_GOALS),
      fetchKpisForPayrollSync: jest.fn().mockResolvedValue({
        month: '2026-08',
        team: { id: TEAM_ID },
        records: [
          {
            user_id: USER_ID,
            employee_id: null,
            group_code: 'CONTENT',
            metric_code: 'CONTENT_NEW',
            target: 150,
            actual: null,
          },
        ],
        warnings: [],
      }),
    };
    const service = new KpiSyncService(
      prisma as never,
      client as never,
      { record: jest.fn().mockResolvedValue({}) } as never,
      makeAuthorizationMock() as never,
    );
    await service.sync(
      { externalTeamId: TEAM_ID, payrollPeriodId: 12 },
      USER_ID,
    );
    const targetCalls = prisma.employeeKpiTarget.upsert.mock.calls as [
      { update: Record<string, unknown> },
    ][];
    expect(targetCalls[0][0].update.targetValue).toBe(150);
    expect(targetCalls[0][0].update).not.toHaveProperty('overrideValue');
    expect(targetCalls[0][0].update).not.toHaveProperty('overrideReason');
    expect(prisma.employeeKpiTarget.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.employeeKpiActual.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.employeeKpiTarget.findUnique).not.toHaveBeenCalled();
    expect(prisma.employeeKpiActual.findUnique).not.toHaveBeenCalled();
    const itemCalls = prisma.kpiSyncRunItem.create.mock.calls as [
      {
        data: {
          recordKind: string;
          appliedValue: Prisma.Decimal;
          resultStatus: string;
        };
      },
    ][];
    const targetItem = itemCalls.find(
      ([input]) => input.data.recordKind === 'TARGET',
    );
    expect(targetItem?.[0].data.resultStatus).toBe('SUCCESS');
    expect(targetItem?.[0].data.appliedValue.toNumber()).toBe(80);
  });

  it('fallback KPI theo tên duy nhất khi user_id chưa được liên kết', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 12,
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      status: 'OPEN',
    });
    prisma.team.findUnique.mockResolvedValue({ id: 3, externalId: TEAM_ID });
    prisma.employee.findMany.mockResolvedValue([
      {
        id: 9,
        externalId: null,
        fullName: 'Nguyễn Văn An',
        user: null,
      },
    ]);
    prisma.kpiGroup.findMany.mockResolvedValue([
      { id: 7, code: 'CONTENT', items: [{ id: 21, code: 'CONTENT_NEW' }] },
    ]);
    prisma.employeeKpiAssignment.findMany.mockResolvedValue([
      { employeeId: 9, kpiGroupId: 7 },
    ]);
    prisma.employeeKpiActual.create.mockResolvedValue({
      id: 31,
      actualValue: new Prisma.Decimal(0),
      dataSource: 'MANUAL',
      manualEnteredAt: null,
      selfConfirmationStatus: 'DRAFT',
      leaderReviewStatus: 'PENDING',
    });
    prisma.kpiSyncRunItem.groupBy.mockResolvedValue([
      { resultStatus: 'SKIPPED', _count: 2 },
    ]);
    prisma.kpiSyncRunItem.count.mockResolvedValue(2);
    prisma.kpiSyncRun.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'run-id', ...data }),
    );
    const client = {
      fetchPerformanceGoalsForPayrollSync: jest
        .fn()
        .mockResolvedValue(EMPTY_PERFORMANCE_GOALS),
      fetchKpisForPayrollSync: jest.fn().mockResolvedValue({
        month: '2026-08',
        team: { id: TEAM_ID },
        records: [
          {
            user_id: USER_ID,
            employee_id: null,
            group_code: 'CONTENT',
            metric_code: 'CONTENT_NEW',
            target: null,
            actual: null,
          },
        ],
        warnings: [],
      }),
      fetchTeamForPayrollSync: jest.fn().mockResolvedValue({
        members: [
          {
            user_id: USER_ID,
            email: '',
            full_name: '  NGUYỄN   VĂN AN ',
          },
        ],
      }),
    };
    const service = new KpiSyncService(
      prisma as never,
      client as never,
      { record: jest.fn() } as never,
      makeAuthorizationMock() as never,
    );

    await service.sync(
      { externalTeamId: TEAM_ID, payrollPeriodId: 12 },
      USER_ID,
    );

    expect(client.fetchTeamForPayrollSync).toHaveBeenCalledWith(TEAM_ID);
    const identityCalls = prisma.externalEmployeeIdentity.upsert.mock
      .calls as unknown as [
      { create: { employeeId: number; externalUserId: string } },
    ][];
    expect(
      identityCalls.some(
        ([input]) =>
          input.create.employeeId === 9 &&
          input.create.externalUserId === USER_ID,
      ),
    ).toBe(true);
    const itemCalls = prisma.kpiSyncRunItem.create.mock.calls as [
      { data: { employeeId?: number } },
    ][];
    expect(itemCalls).toHaveLength(2);
    expect(itemCalls.every(([input]) => input.data.employeeId === 9)).toBe(
      true,
    );
  });

  it('xử lý các record và hai nhánh target/actual đồng thời có giới hạn', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 12,
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      status: 'OPEN',
    });
    prisma.team.findUnique.mockResolvedValue({ id: 3, externalId: TEAM_ID });
    prisma.employee.findMany.mockResolvedValue([]);
    prisma.kpiGroup.findMany.mockResolvedValue([]);
    prisma.employeeKpiAssignment.findMany.mockResolvedValue([]);
    prisma.kpiSyncRunItem.groupBy.mockResolvedValue([
      { resultStatus: 'SKIPPED', _count: 20 },
    ]);
    prisma.kpiSyncRunItem.count.mockResolvedValue(0);
    prisma.kpiSyncRun.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'run-id', ...data }),
    );

    let activeCreates = 0;
    let maxActiveCreates = 0;
    prisma.kpiSyncRunItem.create.mockImplementation(async () => {
      activeCreates += 1;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeCreates -= 1;
      return {};
    });

    const records = Array.from({ length: 10 }, (_, index) => ({
      user_id: `source-user-${index}`,
      employee_id: `AGV-${index}`,
      group_code: 'CONTENT',
      metric_code: `CONTENT_${index}`,
      target: index,
      actual: index,
    }));
    const client = {
      fetchTeamForPayrollSync: jest.fn().mockResolvedValue({
        members: records.map((record) => ({
          user_id: record.user_id,
          email: '',
          full_name: '',
        })),
      }),
      fetchPerformanceGoalsForPayrollSync: jest
        .fn()
        .mockResolvedValue(EMPTY_PERFORMANCE_GOALS),
      fetchKpisForPayrollSync: jest.fn().mockResolvedValue({
        month: '2026-08',
        team: { id: TEAM_ID },
        records,
        warnings: [],
      }),
    };
    const service = new KpiSyncService(
      prisma as never,
      client as never,
      { record: jest.fn() } as never,
      makeAuthorizationMock() as never,
    );

    await service.sync(
      { externalTeamId: TEAM_ID, payrollPeriodId: 12 },
      USER_ID,
    );

    expect(prisma.kpiSyncRunItem.create).toHaveBeenCalledTimes(20);
    expect(maxActiveCreates).toBeGreaterThan(1);
    // 4 worker record x 2 nhánh TARGET/ACTUAL.
    expect(maxActiveCreates).toBeLessThanOrEqual(8);
  });

  it('đồng bộ KPI linh hoạt vào nhóm CONTENT như một KpiItem bình thường', async () => {
    const prisma = makePrismaMock();
    const externalItemId = '79de9f48-206f-47ad-91dc-f68caa4a7418';
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 12,
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      status: 'OPEN',
    });
    prisma.team.findUnique.mockResolvedValue({ id: 3, externalId: TEAM_ID });
    prisma.employee.findMany.mockResolvedValue([
      { id: 9, externalId: USER_ID, employeeCode: 'NV009' },
    ]);
    prisma.kpiGroup.findMany.mockResolvedValue([]);
    prisma.employeeKpiAssignment.findMany.mockResolvedValue([]);
    prisma.kpiGroup.upsert.mockResolvedValue({ id: 7, code: 'CONTENT' });
    prisma.kpiItem.upsert.mockResolvedValue({
      id: 21,
      kpiGroupId: 7,
      externalItemId,
    });
    prisma.employeeKpiAssignment.upsert.mockResolvedValue({ id: 30 });
    prisma.employeeKpiTarget.upsert.mockResolvedValue({
      id: 31,
      targetValue: new Prisma.Decimal(90),
      overrideValue: null,
    });
    prisma.employeeKpiActual.upsert.mockResolvedValue({
      id: 32,
      actualValue: new Prisma.Decimal(85),
    });
    prisma.kpiSyncRunItem.groupBy.mockResolvedValue([
      { resultStatus: 'SUCCESS', _count: 2 },
    ]);
    prisma.kpiSyncRunItem.count.mockResolvedValue(0);
    prisma.kpiSyncRun.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'run-id', ...data }),
    );
    const client = {
      fetchTeamForPayrollSync: jest.fn(),
      fetchKpisForPayrollSync: jest.fn().mockResolvedValue({
        month: '2026-08',
        team: { id: TEAM_ID },
        records: [],
        warnings: [],
      }),
      fetchPerformanceGoalsForPayrollSync: jest.fn().mockResolvedValue({
        contract_version: '2.0',
        month: '2026-08',
        team: { id: TEAM_ID, name: 'K2' },
        generated_at: new Date().toISOString(),
        records: [
          {
            external_item_id: externalItemId,
            revision: 2,
            employee_id: 'NV009',
            user_id: USER_ID,
            team_id: TEAM_ID,
            month: '2026-08',
            item_type: 'KPI',
            kpi_group_id: '10000000-0000-4000-8000-000000000002',
            kpi_group_code: 'CONTENT',
            kpi_group_name: 'Content',
            title: 'Tỷ lệ video đạt chuẩn',
            description: null,
            metric_type: 'PERCENT',
            unit: '%',
            direction: 'AT_LEAST',
            target: 90,
            actual_system: null,
            actual_manual: 85,
            actual_final: 85,
            progress_pct: 94.4444,
            progress_pct_for_overall: 94.4444,
            pass_threshold_pct: 80,
            passed: true,
            actual_source: 'MANUAL_IN_AGV',
            updated_at: '2026-08-20T00:00:00.000Z',
          },
        ],
        warnings: [],
      }),
    };
    const service = new KpiSyncService(
      prisma as never,
      client as never,
      { record: jest.fn().mockResolvedValue({}) } as never,
      makeAuthorizationMock() as never,
    );

    const result = await service.sync(
      { externalTeamId: TEAM_ID, payrollPeriodId: 12 },
      USER_ID,
    );

    expect(result.status).toBe('SUCCESS');
    expect(result.receivedRecords).toBe(1);
    expect(prisma.kpiGroup.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { code: 'CONTENT' },
      }),
    );
    expect(prisma.kpiItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalItemId },
        create: expect.objectContaining({
          kpiGroupId: 7,
          name: 'Tỷ lệ video đạt chuẩn',
          externalItemId,
        }),
      }),
    );
    expect(prisma.employeeKpiAssignment.upsert).toHaveBeenCalled();
    expect(prisma.employeeKpiTarget.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ targetValue: 90 }),
      }),
    );
    expect(prisma.employeeKpiActual.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ actualValue: 85 }),
      }),
    );
    expect(prisma.employeeOkr.upsert).not.toHaveBeenCalled();
    expect(prisma.kpiSyncRunItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupCode: 'CONTENT',
        kpiItemId: 21,
        resultStatus: 'SUCCESS',
      }),
    });
    expect(prisma.kpiSyncRunItem.create).toHaveBeenCalledTimes(2);
  });

  describe('phạm vi team của Leader', () => {
    const OTHER_TEAM_ID = '6a1f4c1e-2b7d-4d8e-9c3a-0f5b7e2d1a90';

    function makeService(
      prisma: ReturnType<typeof makePrismaMock>,
      scope: ResolvedScope,
    ) {
      const client = {
        fetchKpisForPayrollSync: jest.fn(),
        fetchPerformanceGoalsForPayrollSync: jest.fn(),
      };
      const authorization = makeAuthorizationMock(scope);
      const service = new KpiSyncService(
        prisma as never,
        client as never,
        { record: jest.fn() } as never,
        authorization as never,
      );
      return { service, client, authorization };
    }

    it('chặn Leader đồng bộ team ngoài phạm vi và không tạo lượt chạy', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 12,
        startDate: new Date('2026-08-01T00:00:00.000Z'),
        status: 'OPEN',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 9,
        externalId: OTHER_TEAM_ID,
      });
      const { service, client, authorization } = makeService(prisma, {
        type: 'TEAM',
        teamIds: [3],
      });

      await expect(
        service.sync(
          { externalTeamId: OTHER_TEAM_ID, payrollPeriodId: 12 },
          USER_ID,
        ),
      ).rejects.toThrow('phạm vi quản lý');
      expect(authorization.resolvePermissionScope).toHaveBeenCalledWith(
        USER_ID,
        'sync.trigger',
      );
      expect(prisma.kpiSyncRun.create).not.toHaveBeenCalled();
      expect(client.fetchKpisForPayrollSync).not.toHaveBeenCalled();
    });

    it('cho Leader đồng bộ team của mình', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 12,
        startDate: new Date('2026-08-01T00:00:00.000Z'),
        status: 'IN_REVIEW',
      });
      prisma.team.findUnique.mockResolvedValue({ id: 3, externalId: TEAM_ID });
      prisma.kpiSyncRun.update.mockResolvedValue({
        id: 'run-id',
        status: 'SKIPPED',
      });
      const { service } = makeService(prisma, { type: 'TEAM', teamIds: [3] });

      const result = await service.sync(
        { externalTeamId: TEAM_ID, payrollPeriodId: 12 },
        USER_ID,
      );

      expect(result.status).toBe('SKIPPED');
      expect(prisma.kpiSyncRun.create).toHaveBeenCalled();
    });

    it('lịch sử đồng bộ chỉ gồm các team trong phạm vi sync.view', async () => {
      const prisma = makePrismaMock();
      prisma.$transaction.mockImplementation((queries: unknown) =>
        Promise.all(queries as Promise<unknown>[]),
      );
      prisma.team.findMany.mockResolvedValue([{ externalId: TEAM_ID }]);
      const { service, authorization } = makeService(prisma, {
        type: 'TEAM',
        teamIds: [3],
      });

      await service.list({ page: 1, pageSize: 20 }, USER_ID);

      expect(authorization.resolvePermissionScope).toHaveBeenCalledWith(
        USER_ID,
        'sync.view',
      );
      const where = { externalTeamId: { in: [TEAM_ID] } };
      expect(prisma.kpiSyncRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      expect(prisma.kpiSyncRun.count).toHaveBeenCalledWith({ where });
    });

    it('không trả chi tiết lượt đồng bộ của team ngoài phạm vi', async () => {
      const prisma = makePrismaMock();
      prisma.team.findMany.mockResolvedValue([{ externalId: TEAM_ID }]);
      prisma.kpiSyncRun.findFirst.mockResolvedValue(null);
      const { service } = makeService(prisma, { type: 'TEAM', teamIds: [3] });

      await expect(service.get('run-of-other-team', USER_ID)).rejects.toThrow(
        'Không tìm thấy lượt đồng bộ KPI',
      );
      expect(prisma.kpiSyncRun.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            externalTeamId: { in: [TEAM_ID] },
            id: 'run-of-other-team',
          },
        }),
      );
    });

    it('danh sách team được đồng bộ bám theo scope của sync.trigger', async () => {
      const prisma = makePrismaMock();
      prisma.team.findMany.mockResolvedValue([]);
      const leader = makeService(prisma, { type: 'TEAM', teamIds: [3, 4] });

      await leader.service.listSyncableTeams(USER_ID);

      expect(prisma.team.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'ACTIVE',
            externalId: { not: null },
            id: { in: [3, 4] },
          },
        }),
      );

      const self = makeService(makePrismaMock(), { type: 'SELF' });
      await expect(self.service.listSyncableTeams(USER_ID)).resolves.toEqual(
        [],
      );
    });
  });
});
