import { AppException } from '../../../../common/errors/app.exception';
import type { ResolvedScope } from '../../../../common/types/resolved-scope.types';
import { TrafficSyncService } from '../traffic-sync.service';

const ACTOR = '5f876967-bdf7-4ce9-a815-4eeb93ab1990';

type SourceRow = {
  date: string;
  email: string | null;
  name: string | null;
  team: string | null;
  fb: number;
  ig: number;
  tiktok: number;
  yt: number;
  thread: number;
  zalo: number;
  total: number;
  details: { platform: string; channel: string | null; value: number }[];
};

function sourceRow(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    date: '2026-09-20',
    email: 'an@vcb.vn',
    name: 'Quý An',
    team: 'Team K2',
    fb: 0,
    ig: 0,
    tiktok: 0,
    yt: 0,
    thread: 0,
    zalo: 0,
    total: 0,
    details: [],
    ...overrides,
  };
}

function makePrismaMock() {
  const items: Record<string, unknown>[] = [];
  const mock = {
    payrollPeriod: { findUnique: jest.fn() },
    team: { findFirst: jest.fn(), findMany: jest.fn() },
    trafficSyncRun: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'run-id' }),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
          id: 'run-id',
          ...data,
        })),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    payrollPeriodEmployeeSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    employeeTrafficRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
    },
    trafficSyncRunItem: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          items.push(data);
          return Promise.resolve({ id: items.length, ...data });
        }),
      createMany: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown>[] }) => {
          items.push(...data);
          return Promise.resolve({ count: data.length });
        }),
      groupBy: jest.fn().mockImplementation(() => {
        const counts = new Map<string, number>();
        for (const item of items) {
          const status = item.resultStatus as string;
          counts.set(status, (counts.get(status) ?? 0) + 1);
        }
        return Promise.resolve(
          Array.from(counts, ([resultStatus, count]) => ({
            resultStatus,
            _count: { _all: count },
          })),
        );
      }),
    },
    $transaction: jest.fn(),
    items,
  };
  mock.$transaction.mockImplementation(
    (callback: (tx: typeof mock) => Promise<unknown>) => callback(mock),
  );
  mock.employeeTrafficRecord.upsert.mockImplementation(
    ({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve({ id: 99, ...create }),
  );
  return mock;
}

function snapshotOf(
  employeeId: number,
  email: string | null,
  fullName = 'Quý An',
  identityEmail: string | null = email,
) {
  return {
    employee: {
      id: employeeId,
      fullName,
      user: email ? { email } : null,
      externalIdentities: identityEmail
        ? [{ lastKnownEmail: identityEmail }]
        : [],
    },
  };
}

function setup(
  rows: SourceRow[],
  scope: ResolvedScope = { type: 'ALL' },
  allowedEmployeeIds: number[] | 'ALL' = 'ALL',
) {
  const prisma = makePrismaMock();
  const client = {
    fetchTrafficReports: jest.fn().mockResolvedValue({
      range: { from: '2026-09-01', to: '2026-09-30' },
      rows,
    }),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(null) };
  const authorization = {
    resolvePermissionScope: jest.fn().mockResolvedValue(scope),
  };
  const periodScope = {
    resolveEmployeeIds: jest.fn().mockResolvedValue(allowedEmployeeIds),
  };
  const service = new TrafficSyncService(
    prisma as never,
    client as never,
    auditLog as never,
    authorization as never,
    periodScope as never,
  );
  prisma.payrollPeriod.findUnique.mockResolvedValue({
    id: 7,
    status: 'OPEN',
    startDate: new Date('2026-09-01T00:00:00.000Z'),
    endDate: new Date('2026-09-30T00:00:00.000Z'),
  });
  return { service, prisma, client, auditLog, authorization, periodScope };
}

describe('TrafficSyncService.sync', () => {
  it('ghi traffic theo từng nền tảng cho nhân sự khớp được', async () => {
    const { service, prisma, client } = setup([
      sourceRow({ fb: 7_500, ig: 300, total: 7_800 }),
    ]);
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      snapshotOf(11, 'an@vcb.vn'),
    ]);

    const run = await service.sync({ payrollPeriodId: 7 }, ACTOR);

    expect(client.fetchTrafficReports).toHaveBeenCalledWith({
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
      team: undefined,
    });
    const written = (
      prisma.employeeTrafficRecord.upsert.mock.calls as [
        { create: Record<string, unknown> },
      ][]
    ).map(([args]) => args.create);
    expect(written).toEqual([
      expect.objectContaining({
        employeeId: 11,
        platform: 'FACEBOOK',
        views: 7_500n,
        dataSource: 'AUTOMATION_GEN_VIDEO',
      }),
      expect.objectContaining({ platform: 'INSTAGRAM', views: 300n }),
    ]);
    expect(run.status).toBe('SUCCESS');
    expect(run.matchedEmployees).toBe(1);
  });

  it('không tạo bản ghi 0 view cho nền tảng nguồn không có số', async () => {
    const { service, prisma } = setup([sourceRow({ fb: 100, total: 100 })]);
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      snapshotOf(11, 'an@vcb.vn'),
    ]);

    await service.sync({ payrollPeriodId: 7 }, ACTOR);

    expect(prisma.employeeTrafficRecord.upsert).toHaveBeenCalledTimes(1);
    const skipped = prisma.items.filter(
      (item) => item.resultStatus === 'SKIPPED',
    );
    expect(skipped.map((item) => item.platform)).toEqual([
      'INSTAGRAM',
      'TIKTOK',
      'YOUTUBE',
    ]);
  });

  it('không ghi đè traffic đã tự xác nhận và báo CONFLICT khi lệch số', async () => {
    const { service, prisma } = setup([sourceRow({ fb: 7_500, total: 7_500 })]);
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      snapshotOf(11, 'an@vcb.vn'),
    ]);
    prisma.employeeTrafficRecord.findMany.mockResolvedValue([
      {
        id: 42,
        platform: 'FACEBOOK',
        views: 5_000n,
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'PENDING',
      },
    ]);

    const run = await service.sync({ payrollPeriodId: 7 }, ACTOR);

    expect(prisma.employeeTrafficRecord.upsert).not.toHaveBeenCalled();
    const conflict = prisma.items.find(
      (item) => item.resultStatus === 'CONFLICT',
    );
    expect(conflict).toMatchObject({
      platform: 'FACEBOOK',
      previousViews: 5_000n,
      incomingViews: 7_500n,
      appliedViews: 5_000n,
      hasConflict: true,
    });
    expect(run.status).toBe('PARTIAL');
    expect(run.conflictRecords).toBe(1);
  });

  it('coi là SUCCESS khi giá trị đã duyệt trùng đúng số của nguồn', async () => {
    const { service, prisma } = setup([sourceRow({ fb: 5_000, total: 5_000 })]);
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      snapshotOf(11, 'an@vcb.vn'),
    ]);
    prisma.employeeTrafficRecord.findMany.mockResolvedValue([
      {
        id: 42,
        platform: 'FACEBOOK',
        views: 5_000n,
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'APPROVED',
      },
    ]);

    const run = await service.sync({ payrollPeriodId: 7 }, ACTOR);

    expect(prisma.employeeTrafficRecord.upsert).not.toHaveBeenCalled();
    expect(run.status).toBe('SUCCESS');
    expect(run.conflictRecords).toBe(0);
  });

  it('bỏ qua dòng nguồn không khớp được nhân sự nào trong kỳ', async () => {
    const { service, prisma } = setup([
      sourceRow({ email: 'nguoila@vcb.vn', name: 'Người Lạ', fb: 100 }),
    ]);
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      snapshotOf(11, 'an@vcb.vn'),
    ]);

    const run = await service.sync({ payrollPeriodId: 7 }, ACTOR);

    expect(prisma.employeeTrafficRecord.upsert).not.toHaveBeenCalled();
    expect(run.unmatchedRows).toBe(1);
    expect(run.matchedEmployees).toBe(0);
  });

  it('không ghi khi một email khớp nhiều nhân sự đã map', async () => {
    const { service, prisma } = setup([sourceRow({ fb: 100, total: 100 })]);
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      snapshotOf(11, 'an@vcb.vn'),
      snapshotOf(12, 'an@vcb.vn', 'Quý An 2'),
    ]);

    const run = await service.sync({ payrollPeriodId: 7 }, ACTOR);

    expect(prisma.employeeTrafficRecord.upsert).not.toHaveBeenCalled();
    expect(run.unmatchedRows).toBe(1);
    expect(prisma.items[0].message).toContain('khớp nhiều nhân sự');
  });

  it('cảnh báo khi nguồn có traffic ở nền tảng hệ thống lương chưa hỗ trợ', async () => {
    const { service, prisma } = setup([
      sourceRow({ fb: 100, thread: 40, total: 140 }),
    ]);
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      snapshotOf(11, 'an@vcb.vn'),
    ]);

    const run = await service.sync({ payrollPeriodId: 7 }, ACTOR);

    expect(run.warningCount).toBe(1);
    expect(run.sourceWarnings).toEqual([
      expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }),
    ]);
  });

  it('không đụng vào dữ liệu khi kỳ lương không còn mở', async () => {
    const { service, prisma, client } = setup([sourceRow({ fb: 100 })]);
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 7,
      status: 'IN_REVIEW',
      startDate: new Date('2026-09-01T00:00:00.000Z'),
      endDate: new Date('2026-09-30T00:00:00.000Z'),
    });

    const run = await service.sync({ payrollPeriodId: 7 }, ACTOR);

    expect(run.status).toBe('SKIPPED');
    expect(client.fetchTrafficReports).not.toHaveBeenCalled();
    expect(prisma.employeeTrafficRecord.upsert).not.toHaveBeenCalled();
  });

  it('chặn hai lượt đồng bộ chạy song song trên cùng kỳ lương', async () => {
    const { service, prisma } = setup([]);
    prisma.trafficSyncRun.findFirst.mockResolvedValue({
      id: 'dang-chay',
      startedAt: new Date(),
    });

    await expect(service.sync({ payrollPeriodId: 7 }, ACTOR)).rejects.toThrow(
      AppException,
    );
    expect(prisma.trafficSyncRun.create).not.toHaveBeenCalled();
  });

  it('mở khoá kỳ khi lượt cũ treo quá lâu thay vì chặn vĩnh viễn', async () => {
    const { service, prisma } = setup([]);
    prisma.trafficSyncRun.findFirst.mockResolvedValue({
      id: 'treo',
      startedAt: new Date(Date.now() - 60 * 60_000),
    });

    await service.sync({ payrollPeriodId: 7 }, ACTOR);

    const [[closeStale]] = prisma.trafficSyncRun.update.mock.calls as [
      { where: { id: string }; data: { status: string } },
    ][];
    expect(closeStale.where.id).toBe('treo');
    expect(closeStale.data.status).toBe('FAILED');
    expect(prisma.trafficSyncRun.create).toHaveBeenCalled();
  });

  it('vẫn ném lỗi gốc khi không đánh dấu FAILED được', async () => {
    const { service, prisma, client } = setup([]);
    client.fetchTrafficReports.mockRejectedValue(new Error('nguồn sập'));
    prisma.trafficSyncRun.update.mockRejectedValue(new Error('hết connection'));

    await expect(service.sync({ payrollPeriodId: 7 }, ACTOR)).rejects.toThrow(
      'nguồn sập',
    );
  });

  it('đánh dấu run FAILED và ném lỗi khi nguồn không gọi được', async () => {
    const { service, prisma, client } = setup([]);
    client.fetchTrafficReports.mockRejectedValue(
      new Error('AutomationGenVideo chưa mở endpoint'),
    );

    await expect(service.sync({ payrollPeriodId: 7 }, ACTOR)).rejects.toThrow(
      'AutomationGenVideo chưa mở endpoint',
    );
    const [[updateArgs]] = prisma.trafficSyncRun.update.mock.calls as [
      { data: { status: string; errorSummary: string } },
    ][];
    expect(updateArgs.data.status).toBe('FAILED');
    expect(updateArgs.data.errorSummary).toContain('chưa mở endpoint');
  });

  it('chỉ hỏi nguồn đúng khoảng ngày của kỳ, và tôn trọng ngày truyền tay', async () => {
    const { service, client } = setup([]);

    await service.sync(
      { payrollPeriodId: 7, dateFrom: '2026-09-10', dateTo: '2026-09-15' },
      ACTOR,
    );

    expect(client.fetchTrafficReports).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: '2026-09-10', dateTo: '2026-09-15' }),
    );
  });

  it('từ chối khoảng ngày ngược', async () => {
    const { service } = setup([]);

    await expect(
      service.sync(
        { payrollPeriodId: 7, dateFrom: '2026-09-20', dateTo: '2026-09-10' },
        ACTOR,
      ),
    ).rejects.toThrow(AppException);
  });
});

describe('TrafficSyncService — phạm vi team của Leader', () => {
  const LEADER_SCOPE: ResolvedScope = { type: 'TEAM', teamIds: [3] };

  it('không cho Leader kéo toàn hệ thống', async () => {
    const { service, prisma, client } = setup([], LEADER_SCOPE);

    await expect(service.sync({ payrollPeriodId: 7 }, ACTOR)).rejects.toThrow(
      'Hãy chọn team bạn quản lý',
    );
    expect(prisma.trafficSyncRun.create).not.toHaveBeenCalled();
    expect(client.fetchTrafficReports).not.toHaveBeenCalled();
  });

  it('không cho Leader kéo team ngoài phạm vi', async () => {
    const { service, prisma, client, authorization } = setup([], LEADER_SCOPE);
    prisma.team.findFirst.mockResolvedValue(null);

    await expect(
      service.sync({ payrollPeriodId: 7, externalTeamName: 'Team K9' }, ACTOR),
    ).rejects.toThrow('phạm vi quản lý');
    expect(authorization.resolvePermissionScope).toHaveBeenCalledWith(
      ACTOR,
      'sync.trigger',
    );
    expect(prisma.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: [3] },
          externalId: { not: null },
          name: 'Team K9',
        },
      }),
    );
    expect(prisma.trafficSyncRun.create).not.toHaveBeenCalled();
    expect(client.fetchTrafficReports).not.toHaveBeenCalled();
  });

  it('Leader kéo team mình và chỉ khớp vào nhân sự thuộc team trong kỳ', async () => {
    const { service, prisma, client, periodScope } = setup(
      [sourceRow({ fb: 100, total: 100 })],
      LEADER_SCOPE,
      [11],
    );
    prisma.team.findFirst.mockResolvedValue({ id: 3 });
    prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
      snapshotOf(11, 'an@vcb.vn'),
    ]);

    const run = await service.sync(
      { payrollPeriodId: 7, externalTeamName: 'Team K2' },
      ACTOR,
    );

    expect(client.fetchTrafficReports).toHaveBeenCalledWith(
      expect.objectContaining({ team: 'Team K2' }),
    );
    expect(periodScope.resolveEmployeeIds).toHaveBeenCalledWith(
      LEADER_SCOPE,
      7,
      null,
    );
    expect(prisma.payrollPeriodEmployeeSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { payrollPeriodId: 7, employeeId: { in: [11] } },
      }),
    );
    expect(run.matchedEmployees).toBe(1);
  });

  it('lịch sử chỉ gồm lượt của team mình, ẩn lượt toàn hệ thống', async () => {
    const { service, prisma, authorization } = setup([], LEADER_SCOPE);
    prisma.$transaction.mockImplementation((queries: unknown) =>
      Promise.all(queries as Promise<unknown>[]),
    );
    prisma.team.findMany.mockResolvedValue([{ name: 'Team K2' }]);
    prisma.trafficSyncRun.findMany.mockResolvedValue([]);
    prisma.trafficSyncRun.count.mockResolvedValue(0);

    await service.list({ page: 1, pageSize: 20 }, ACTOR);

    expect(authorization.resolvePermissionScope).toHaveBeenCalledWith(
      ACTOR,
      'sync.view',
    );
    const where = { externalTeamName: { in: ['Team K2'] } };
    expect(prisma.trafficSyncRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(prisma.trafficSyncRun.count).toHaveBeenCalledWith({ where });
  });

  it('không trả chi tiết lượt đồng bộ ngoài phạm vi', async () => {
    const { service, prisma } = setup([], LEADER_SCOPE);
    prisma.team.findMany.mockResolvedValue([{ name: 'Team K2' }]);
    prisma.trafficSyncRun.findFirst.mockResolvedValue(null);

    await expect(service.get('run-toan-he-thong', ACTOR)).rejects.toThrow(
      'Không tìm thấy lượt đồng bộ traffic',
    );
    expect(prisma.trafficSyncRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          externalTeamName: { in: ['Team K2'] },
          id: 'run-toan-he-thong',
        },
      }),
    );
  });

  it('chỉ scope ALL mới được chọn toàn hệ thống trong dialog', async () => {
    const leader = setup([], LEADER_SCOPE);
    leader.prisma.team.findMany.mockResolvedValue([{ id: 3, name: 'Team K2' }]);
    await expect(leader.service.listSyncableTeams(ACTOR)).resolves.toEqual({
      canSyncAllTeams: false,
      teams: [{ id: 3, name: 'Team K2' }],
    });
    expect(leader.prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: [3] },
          externalId: { not: null },
          status: 'ACTIVE',
        },
      }),
    );

    const admin = setup([]);
    admin.prisma.team.findMany.mockResolvedValue([]);
    await expect(admin.service.listSyncableTeams(ACTOR)).resolves.toEqual({
      canSyncAllTeams: true,
      teams: [],
    });
  });
});
