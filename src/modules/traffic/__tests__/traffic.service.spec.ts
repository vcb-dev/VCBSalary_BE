import { TrafficService } from '../traffic.service';

function trafficRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    employeeId: 1,
    payrollPeriodId: 2,
    platform: 'TIKTOK',
    platformName: '',
    views: 12500000n,
    selfConfirmationStatus: 'DRAFT',
    selfConfirmedByUserId: null,
    selfConfirmedAt: null,
    leaderReviewStatus: 'PENDING',
    leaderReviewedByUserId: null,
    leaderReviewedAt: null,
    leaderRejectionReason: null,
    createdAt: new Date('2026-09-05T02:00:00Z'),
    updatedAt: new Date('2026-09-05T02:00:00Z'),
    selfConfirmedBy: null,
    leaderReviewedBy: null,
    attachments: [],
    ...overrides,
  };
}

function snapshot(records: ReturnType<typeof trafficRecord>[] = []) {
  return {
    id: 20,
    employeeId: 1,
    payrollPeriodId: 2,
    employeeCodeSnapshot: 'NV-000001',
    employeeNameSnapshot: 'Nguyễn Minh Anh',
    jobTitleSnapshot: 'Editor',
    employeeGroupsSnapshot: ['EDITOR'],
    teamIdSnapshot: 3,
    teamCodeSnapshot: 'TEAM-A',
    teamNameSnapshot: 'Team Alpha',
    leaderEmployeeIdSnapshot: 9,
    leaderNameSnapshot: 'Leader A',
    managerEmployeeIdSnapshot: null,
    managerNameSnapshot: null,
    employmentStatusSnapshot: 'ACTIVE',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    employee: { trafficRecords: records },
  };
}

function makePrismaMock() {
  const mock = {
    payrollPeriod: {
      findUnique: jest.fn().mockResolvedValue({ id: 2, status: 'OPEN' }),
    },
    payrollPeriodEmployeeSnapshot: {
      findMany: jest.fn().mockResolvedValue([snapshot()]),
      findUnique: jest.fn().mockResolvedValue(snapshot()),
      count: jest.fn().mockResolvedValue(1),
    },
    employeeTrafficRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue(trafficRecord()),
      create: jest.fn().mockResolvedValue(trafficRecord()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    trafficRecordAttachment: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    fileAttachment: {
      findMany: jest.fn().mockResolvedValue([]),
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

function makeAuthorizationMock(options?: {
  scope?:
    { type: 'ALL' } | { type: 'TEAM'; teamIds: number[] } | { type: 'SELF' };
  employeeId?: number | null;
  permissions?: string[];
}) {
  return {
    resolveScope: jest
      .fn()
      .mockResolvedValue(options?.scope ?? { type: 'ALL' }),
    resolvePermissionScope: jest
      .fn()
      .mockResolvedValue(options?.scope ?? { type: 'ALL' }),
    getEmployeeId: jest.fn().mockResolvedValue(options?.employeeId ?? null),
    getPermissionCodes: jest
      .fn()
      .mockResolvedValue(new Set(options?.permissions ?? [])),
  };
}

function makeAuditLogMock() {
  return { record: jest.fn().mockResolvedValue({}) };
}

function makeFilesMock() {
  return {
    getForAuthorizedAccess: jest.fn(),
    getManyForAuthorizedAccess: jest.fn().mockResolvedValue([]),
  };
}

function callArg<T>(mock: jest.Mock, argumentIndex: number): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0]?.[argumentIndex] as T;
}

describe('TrafficService', () => {
  it('returns all four platforms and aggregates only approved traffic as accepted', async () => {
    const prisma = makePrismaMock();
    prisma.employeeTrafficRecord.findMany.mockResolvedValue([
      trafficRecord({
        views: 100n,
        selfConfirmationStatus: 'CONFIRMED',
        leaderReviewStatus: 'APPROVED',
      }),
      trafficRecord({ id: 11, platform: 'YOUTUBE', views: 50n }),
    ]);
    const files = makeFilesMock();
    const service = new TrafficService(
      prisma as never,
      makeAuthorizationMock() as never,
      makeAuditLogMock() as never,
      files as never,
    );

    const result = await service.getForEmployee('admin', 2, 1);

    expect(result.totalViews).toBe('150');
    expect(result.acceptedViews).toBe('100');
    expect(result.records).toHaveLength(4);
    expect(files.getManyForAuthorizedAccess).toHaveBeenCalledTimes(1);
    expect(
      result.records.find((item) => item.platform === 'FACEBOOK'),
    ).toMatchObject({
      id: null,
      views: '0',
    });
  });

  it('creates one unique employee/period/platform row and writes its audit event', async () => {
    const prisma = makePrismaMock();
    const auditLog = makeAuditLogMock();
    const authorization = makeAuthorizationMock({
      employeeId: 1,
      permissions: ['traffic.write_self'],
    });
    const service = new TrafficService(
      prisma as never,
      authorization as never,
      auditLog as never,
      makeFilesMock() as never,
    );

    const result = await service.upsert('employee-user', 2, 1, 'TIKTOK', {
      views: '12500000',
      attachmentIds: [],
    });

    expect(prisma.employeeTrafficRecord.create).toHaveBeenCalledWith({
      data: {
        employeeId: 1,
        payrollPeriodId: 2,
        platform: 'TIKTOK',
        platformName: '',
        views: 12500000n,
      },
    });
    const audit = callArg<{
      action: string;
      afterData: { views: string };
    }>(auditLog.record, 1);
    expect(audit.action).toBe('TRAFFIC_CREATED');
    expect(audit.afterData.views).toBe('12500000');
    expect(result.views).toBe('12500000');
  });

  it('does not let a self-only user write another employee traffic', async () => {
    const prisma = makePrismaMock();
    const service = new TrafficService(
      prisma as never,
      makeAuthorizationMock({
        employeeId: 99,
        permissions: ['traffic.write_self'],
      }) as never,
      makeAuditLogMock() as never,
      makeFilesMock() as never,
    );

    await expect(
      service.upsert('employee-user', 2, 1, 'FACEBOOK', { views: '10' }),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    expect(prisma.employeeTrafficRecord.create).not.toHaveBeenCalled();
  });

  it('self-confirm resubmits a rejected record and resets review to pending', async () => {
    const prisma = makePrismaMock();
    prisma.employeeTrafficRecord.findUnique.mockResolvedValue(
      trafficRecord({
        leaderReviewStatus: 'REJECTED',
        leaderRejectionReason: 'Sai ảnh',
      }),
    );
    const service = new TrafficService(
      prisma as never,
      makeAuthorizationMock({ employeeId: 1 }) as never,
      makeAuditLogMock() as never,
      makeFilesMock() as never,
    );

    await service.selfConfirm('employee-user', 10);

    const update = callArg<{
      data: {
        selfConfirmationStatus: string;
        leaderReviewStatus: string;
        leaderRejectionReason: string | null;
      };
    }>(prisma.employeeTrafficRecord.updateMany, 0);
    expect(update.data).toMatchObject({
      selfConfirmationStatus: 'CONFIRMED',
      leaderReviewStatus: 'PENDING',
      leaderRejectionReason: null,
    });
  });

  it('leader rejection reopens the record for editing and requires a later resubmit', async () => {
    const prisma = makePrismaMock();
    prisma.employeeTrafficRecord.findUnique.mockResolvedValue(
      trafficRecord({ selfConfirmationStatus: 'CONFIRMED' }),
    );
    const auditLog = makeAuditLogMock();
    const service = new TrafficService(
      prisma as never,
      makeAuthorizationMock({
        scope: { type: 'TEAM', teamIds: [3] },
        employeeId: 9,
      }) as never,
      auditLog as never,
      makeFilesMock() as never,
    );

    await service.leaderReject('leader-user', 10, {
      reason: 'Thiếu minh chứng',
    });

    const update = callArg<{
      data: {
        leaderReviewStatus: string;
        selfConfirmationStatus: string;
        selfConfirmedByUserId: string | null;
      };
    }>(prisma.employeeTrafficRecord.updateMany, 0);
    expect(update.data).toMatchObject({
      leaderReviewStatus: 'REJECTED',
      selfConfirmationStatus: 'DRAFT',
      selfConfirmedByUserId: null,
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        action: 'TRAFFIC_LEADER_REJECTED',
        reason: 'Thiếu minh chứng',
      }),
    );
  });

  it('does not let a team-scoped leader approve their own traffic', async () => {
    const prisma = makePrismaMock();
    prisma.employeeTrafficRecord.findUnique.mockResolvedValue(
      trafficRecord({ selfConfirmationStatus: 'CONFIRMED' }),
    );
    const service = new TrafficService(
      prisma as never,
      makeAuthorizationMock({
        scope: { type: 'TEAM', teamIds: [3] },
        employeeId: 1,
      }) as never,
      makeAuditLogMock() as never,
      makeFilesMock() as never,
    );

    await expect(
      service.leaderApprove('leader-user', 10),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.employeeTrafficRecord.updateMany).not.toHaveBeenCalled();
  });

  it('does not overwrite a concurrent traffic review decision', async () => {
    const prisma = makePrismaMock();
    prisma.employeeTrafficRecord.findUnique.mockResolvedValue(
      trafficRecord({ selfConfirmationStatus: 'CONFIRMED' }),
    );
    prisma.employeeTrafficRecord.updateMany.mockResolvedValue({ count: 0 });
    const auditLog = makeAuditLogMock();
    const service = new TrafficService(
      prisma as never,
      makeAuthorizationMock({ scope: { type: 'ALL' }, employeeId: 9 }) as never,
      auditLog as never,
      makeFilesMock() as never,
    );

    await expect(
      service.leaderApprove('leader-user', 10),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('rejects updates after the payroll period is closed', async () => {
    const prisma = makePrismaMock();
    prisma.payrollPeriod.findUnique.mockResolvedValue({
      id: 2,
      status: 'CLOSED',
    });
    const service = new TrafficService(
      prisma as never,
      makeAuthorizationMock({
        employeeId: 1,
        permissions: ['traffic.write_self'],
      }) as never,
      makeAuditLogMock() as never,
      makeFilesMock() as never,
    );

    await expect(
      service.upsert('employee-user', 2, 1, 'INSTAGRAM', { views: '10' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('TrafficService custom platforms', () => {
  function makeService(prisma = makePrismaMock()) {
    const auditLog = makeAuditLogMock();
    const service = new TrafficService(
      prisma as never,
      makeAuthorizationMock({
        employeeId: 1,
        permissions: ['traffic.write_self'],
      }) as never,
      auditLog as never,
      makeFilesMock() as never,
    );
    return { prisma, auditLog, service };
  }

  it('lists custom platforms after the four fixed platforms with their own name', async () => {
    const { prisma, service } = makeService();
    prisma.employeeTrafficRecord.findMany.mockResolvedValue([
      trafficRecord({ id: 30, platform: 'OTHER', platformName: 'Threads' }),
      trafficRecord({ id: 11, platform: 'YOUTUBE', views: 50n }),
    ]);

    const result = await service.getForEmployee('employee-user', 2, 1);

    expect(result.records.map((record) => record.platform)).toEqual([
      'TIKTOK',
      'FACEBOOK',
      'YOUTUBE',
      'INSTAGRAM',
      'OTHER',
    ]);
    expect(result.records[4]).toMatchObject({
      id: 30,
      platformName: 'Threads',
    });
    expect(result.records[2].platformName).toBeNull();
  });

  it('creates a custom platform row keyed by its name', async () => {
    const { prisma, auditLog, service } = makeService();
    prisma.employeeTrafficRecord.findUniqueOrThrow.mockResolvedValue(
      trafficRecord({ id: 30, platform: 'OTHER', platformName: 'Threads' }),
    );

    const result = await service.createCustom('employee-user', 2, 1, {
      platformName: 'Threads',
      views: '3000',
    });

    expect(prisma.employeeTrafficRecord.create).toHaveBeenCalledWith({
      data: {
        employeeId: 1,
        payrollPeriodId: 2,
        platform: 'OTHER',
        platformName: 'Threads',
        views: 3000n,
      },
    });
    const audit = callArg<{
      action: string;
      afterData: { platformName: string };
    }>(auditLog.record, 1);
    expect(audit.action).toBe('TRAFFIC_CREATED');
    expect(audit.afterData.platformName).toBe('Threads');
    expect(result.platformName).toBe('Threads');
  });

  it('rejects a custom name that differs only by letter case', async () => {
    const { prisma, service } = makeService();
    prisma.employeeTrafficRecord.findMany.mockResolvedValue([
      { platformName: 'Threads' },
    ]);

    await expect(
      service.createCustom('employee-user', 2, 1, {
        platformName: 'threads',
        views: '10',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(prisma.employeeTrafficRecord.create).not.toHaveBeenCalled();
  });

  it('rejects a custom name that duplicates a fixed platform', async () => {
    const { prisma, service } = makeService();

    await expect(
      service.createCustom('employee-user', 2, 1, {
        platformName: 'TikTok',
        views: '10',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.employeeTrafficRecord.create).not.toHaveBeenCalled();
  });

  it('does not accept OTHER through the fixed platform upsert', async () => {
    const { prisma, service } = makeService();

    await expect(
      service.upsert('employee-user', 2, 1, 'OTHER', { views: '10' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.employeeTrafficRecord.create).not.toHaveBeenCalled();
  });

  it('renames a draft custom platform and checks other names of the employee', async () => {
    const { prisma, service } = makeService();
    prisma.employeeTrafficRecord.findUnique.mockResolvedValue(
      trafficRecord({ id: 30, platform: 'OTHER', platformName: 'Thread' }),
    );

    await service.updateCustom('employee-user', 30, {
      platformName: 'Threads',
      views: '20',
    });

    const siblingQuery = callArg<{
      where: { platform: string; id: unknown };
    }>(prisma.employeeTrafficRecord.findMany, 0);
    expect(siblingQuery.where).toMatchObject({
      platform: 'OTHER',
      id: { not: 30 },
    });
    const update = callArg<{ data: unknown }>(
      prisma.employeeTrafficRecord.updateMany,
      0,
    );
    expect(update.data).toEqual({ views: 20n, platformName: 'Threads' });
  });

  it('only renames or deletes custom platforms', async () => {
    const { prisma, service } = makeService();
    prisma.employeeTrafficRecord.findUnique.mockResolvedValue(trafficRecord());

    await expect(
      service.deleteCustom('employee-user', 10),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.employeeTrafficRecord.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes a draft custom platform and keeps its values in the audit log', async () => {
    const { prisma, auditLog, service } = makeService();
    prisma.employeeTrafficRecord.findUnique.mockResolvedValue(
      trafficRecord({
        id: 30,
        platform: 'OTHER',
        platformName: 'Threads',
        views: 99n,
      }),
    );

    await expect(service.deleteCustom('employee-user', 30)).resolves.toEqual({
      id: 30,
      deleted: true,
    });
    const audit = callArg<{
      action: string;
      beforeData: { platformName: string; views: string };
    }>(auditLog.record, 1);
    expect(audit.action).toBe('TRAFFIC_DELETED');
    expect(audit.beforeData).toMatchObject({
      platformName: 'Threads',
      views: '99',
    });
  });

  it('does not delete a custom platform that was already self-confirmed', async () => {
    const { prisma, service } = makeService();
    prisma.employeeTrafficRecord.findUnique.mockResolvedValue(
      trafficRecord({
        id: 30,
        platform: 'OTHER',
        platformName: 'Threads',
        selfConfirmationStatus: 'CONFIRMED',
      }),
    );

    await expect(
      service.deleteCustom('employee-user', 30),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.employeeTrafficRecord.deleteMany).not.toHaveBeenCalled();
  });
});
