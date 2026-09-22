import { PayrollPeriodsService } from '../payroll-periods.service';

interface PrismaMock {
  user: {
    findFirst: jest.Mock;
  };
  payrollPeriod: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    aggregate: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  employee: {
    findMany: jest.Mock;
  };
  payrollPeriodEmployeeSnapshot: {
    createMany: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  payrollPeriodEmployeeTeamSnapshot: { createMany: jest.Mock };
  rewardRuleSet: {
    findFirst: jest.Mock;
  };
  kpiGroup: {
    findMany: jest.Mock;
  };
  employeeKpiAssignment: {
    createMany: jest.Mock;
  };
  employeeKpiActual: {
    createMany: jest.Mock;
  };
  salaryRecord: {
    findMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: 'user-admin' }),
    },
    payrollPeriod: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _max: { id: 0 } }),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(),
    },
    employee: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    payrollPeriodEmployeeSnapshot: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    payrollPeriodEmployeeTeamSnapshot: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    rewardRuleSet: {
      // Mặc định có 1 version ACTIVE — hầu hết test không quan tâm tới guard này, chỉ test
      // "no active rule set" mới override về null.
      findFirst: jest.fn().mockResolvedValue({ id: 'rrs-1', version: 1 }),
    },
    kpiGroup: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    employeeKpiAssignment: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    employeeKpiActual: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    salaryRecord: {
      findMany: jest.fn().mockResolvedValue([]),
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

function firstCallArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0]?.[0] as T;
}

describe('PayrollPeriodsService', () => {
  describe('create', () => {
    it('generates the period code automatically', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.create.mockResolvedValue({
        id: 1,
        code: 'KY-000001',
      });
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create({
          name: 'Kỳ 09/2026',
          startDate: '2026-09-01',
          endDate: '2026-09-30',
        }),
      ).resolves.toMatchObject({ code: 'KY-000001' });
      const create = firstCallArg<{ data: { code: string } }>(
        prisma.payrollPeriod.create,
      );
      expect(create.data.code).toBe('KY-000001');
      expect(create.data).toMatchObject({
        payrollYear: 2026,
        payrollMonth: 9,
      });
    });

    it('rejects a partial-month period', async () => {
      const prisma = makePrismaMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create({
          name: 'Nửa tháng 09/2026',
          startDate: '2026-09-01',
          endDate: '2026-09-15',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects startDate >= endDate', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue(null);
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create({
          code: '2026-09',
          name: 'Kỳ 09/2026',
          startDate: '2026-09-30',
          endDate: '2026-09-01',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an overlapping date range with an existing period', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue(null);
      prisma.payrollPeriod.findFirst.mockResolvedValue({
        id: 'other',
        code: '2026-09',
      });
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.create({
          code: '2026-09-B',
          name: 'Kỳ trùng',
          startDate: '2026-09-15',
          endDate: '2026-10-05',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('monthly automation', () => {
    it('creates the current calendar month once and then opens it', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue(null);
      prisma.payrollPeriod.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 99, status: 'DRAFT', ...data }),
      );
      const auditLog = makeAuditLogMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        auditLog as never,
      );
      const opened = {
        id: 99,
        code: 'LUONG-2026-09',
        status: 'OPEN',
      };
      const openSpy = jest
        .spyOn(service, 'open')
        .mockResolvedValue(opened as never);

      await expect(
        service.ensureCurrentMonthOpen(new Date('2026-09-21T02:00:00Z')),
      ).resolves.toEqual(opened);

      const createCall = firstCallArg<{
        data: {
          code: string;
          name: string;
          payrollYear: number;
          payrollMonth: number;
          startDate: Date;
          endDate: Date;
        };
      }>(prisma.payrollPeriod.create);
      expect(createCall.data).toMatchObject({
        code: 'LUONG-2026-09',
        name: 'Kỳ lương tháng 09/2026',
        payrollYear: 2026,
        payrollMonth: 9,
        startDate: new Date('2026-09-01T00:00:00.000Z'),
        endDate: new Date('2026-09-30T00:00:00.000Z'),
      });
      expect(openSpy).toHaveBeenCalledWith(99, 'user-admin');
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'PAYROLL_PERIOD_CREATED' }),
      );
    });

    it('does nothing when the monthly period is already open', async () => {
      const prisma = makePrismaMock();
      const existing = {
        id: 9,
        payrollYear: 2026,
        payrollMonth: 9,
        status: 'OPEN',
      };
      prisma.payrollPeriod.findUnique.mockResolvedValue(existing);
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.ensureCurrentMonthOpen(new Date('2026-09-21T02:00:00Z')),
      ).resolves.toEqual(existing);
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.payrollPeriod.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects editing a period that is not DRAFT', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'OPEN',
        code: '2026-09',
        startDate: new Date('2026-09-01'),
        endDate: new Date('2026-09-30'),
      });
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.update('p1', { name: 'Đổi tên' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('open', () => {
    it('transitions DRAFT -> OPEN, snapshots active employees, and records an audit entry', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'DRAFT',
      });
      prisma.payrollPeriod.findUniqueOrThrow.mockResolvedValue({
        id: 'p1',
        status: 'OPEN',
      });
      prisma.employee.findMany.mockResolvedValue([
        {
          id: 'e1',
          employeeCode: 'NV-01',
          fullName: 'Nguyễn Văn A',
          jobTitle: 'Editor',
          employeeGroups: [],
          teamId: 't1',
          team: { code: 'TEAM-A', name: 'Team A' },
          leaderEmployeeId: null,
          leader: null,
          managerEmployeeId: null,
          manager: null,
          employmentStatus: 'ACTIVE',
          teamMemberships: [
            {
              id: 'm1',
              teamId: 't1',
              team: { code: 'TEAM-A', name: 'Team A' },
              isPrimary: true,
              defaultSalaryWeightPercent: 100,
              leaderEmployeeId: null,
              leader: null,
              managerEmployeeId: null,
              manager: null,
            },
          ],
        },
      ]);
      const auditLog = makeAuditLogMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        auditLog as never,
      );

      await service.open('p1', 'user-admin');

      expect(prisma.employee.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { employmentStatus: { not: 'LEFT' } },
        }),
      );
      expect(
        prisma.payrollPeriodEmployeeSnapshot.createMany,
      ).toHaveBeenCalledTimes(1);
      const snapshotArg = (
        prisma.payrollPeriodEmployeeSnapshot.createMany.mock.calls[0] as [
          { data: { employeeCodeSnapshot: string }[] },
        ]
      )[0];
      expect(snapshotArg.data[0].employeeCodeSnapshot).toBe('NV-01');
      const updateArg = (
        prisma.payrollPeriod.updateMany.mock.calls[0] as [
          { data: { rewardRuleSetId: string } },
        ]
      )[0];
      expect(updateArg.data.rewardRuleSetId).toBe('rrs-1');
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'PAYROLL_PERIOD_OPENED' }),
      );
    });

    it('automatically assigns matching active KPI groups and creates actual rows', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'DRAFT',
      });
      prisma.payrollPeriod.findUniqueOrThrow.mockResolvedValue({
        id: 'p1',
        status: 'OPEN',
      });
      prisma.employee.findMany.mockResolvedValue([
        {
          id: 'editor-1',
          employeeCode: 'ED-01',
          fullName: 'Editor A',
          jobTitle: 'Video Editor',
          employeeGroups: [{ id: 1, code: 'EDITOR' }],
          teamId: 't1',
          team: { code: 'TEAM-A', name: 'Team A' },
          leaderEmployeeId: null,
          leader: null,
          managerEmployeeId: null,
          manager: null,
          employmentStatus: 'ACTIVE',
          teamMemberships: [
            {
              id: 'm-editor',
              teamId: 't1',
              team: { code: 'TEAM-A', name: 'Team A' },
              isPrimary: true,
              defaultSalaryWeightPercent: 100,
              leaderEmployeeId: null,
              leader: null,
              managerEmployeeId: null,
              manager: null,
            },
          ],
        },
        {
          id: 'hybrid-1',
          employeeCode: 'CC-01',
          fullName: 'Creator A',
          jobTitle: 'Content Creator',
          employeeGroups: [
            { id: 1, code: 'EDITOR' },
            { id: 2, code: 'CONTENT_CREATOR' },
          ],
          teamId: 't1',
          team: { code: 'TEAM-A', name: 'Team A' },
          leaderEmployeeId: null,
          leader: null,
          managerEmployeeId: null,
          manager: null,
          employmentStatus: 'ACTIVE',
          teamMemberships: [
            {
              id: 'm-hybrid',
              teamId: 't1',
              team: { code: 'TEAM-A', name: 'Team A' },
              isPrimary: true,
              defaultSalaryWeightPercent: 100,
              leaderEmployeeId: null,
              leader: null,
              managerEmployeeId: null,
              manager: null,
            },
          ],
        },
      ]);
      prisma.kpiGroup.findMany.mockResolvedValue([
        {
          id: 'group-editor',
          applicableEmployeeGroups: [{ id: 1 }],
          items: [{ id: 'item-video' }],
        },
        {
          id: 'group-content',
          applicableEmployeeGroups: [{ id: 2 }],
          items: [{ id: 'item-content' }],
        },
        {
          id: 'group-manual',
          applicableEmployeeGroups: [],
          items: [{ id: 'item-manual' }],
        },
      ]);
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      const result = await service.open('p1', 'user-admin');

      expect(result).toEqual(
        expect.objectContaining({ automaticKpiAssignmentCount: 3 }),
      );
      const assignmentArg = (
        prisma.employeeKpiAssignment.createMany.mock.calls[0] as [
          { data: { employeeId: string; kpiGroupId: string }[] },
        ]
      )[0];
      expect(assignmentArg.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            employeeId: 'editor-1',
            kpiGroupId: 'group-editor',
          }),
          expect.objectContaining({
            employeeId: 'hybrid-1',
            kpiGroupId: 'group-editor',
          }),
          expect.objectContaining({
            employeeId: 'hybrid-1',
            kpiGroupId: 'group-content',
          }),
        ]),
      );
      expect(assignmentArg.data).toHaveLength(3);
      const actualArg = (
        prisma.employeeKpiActual.createMany.mock.calls[0] as [
          { data: { employeeId: string; kpiItemId: string }[] },
        ]
      )[0];
      expect(actualArg.data).toHaveLength(3);
      expect(actualArg.data).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kpiItemId: 'item-manual' }),
        ]),
      );
    });

    it('is idempotent: opening an already-OPEN period is rejected without creating duplicate snapshots', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'OPEN',
      });
      const auditLog = makeAuditLogMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        auditLog as never,
      );

      await expect(service.open('p1', 'user-admin')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(
        prisma.payrollPeriodEmployeeSnapshot.createMany,
      ).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rejects a concurrent open after another request has claimed the DRAFT row', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'DRAFT',
      });
      prisma.payrollPeriod.updateMany.mockResolvedValue({ count: 0 });
      const auditLog = makeAuditLogMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        auditLog as never,
      );

      await expect(service.open('p1', 'user-admin')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(
        prisma.payrollPeriodEmployeeSnapshot.createMany,
      ).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('từ chối mở kỳ và nêu tên nhân sự lệch tỷ trọng KPI', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'DRAFT',
      });
      prisma.employee.findMany.mockResolvedValue([
        {
          id: 'e1',
          employeeCode: 'NV-01',
          fullName: 'Nguyễn Văn A',
          teamMemberships: [
            { isPrimary: true, defaultSalaryWeightPercent: 60 },
          ],
        },
      ]);
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      const error: unknown = await service
        .open('p1', 'user-admin')
        .catch((err: unknown) => err);

      expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
      // Toast của FE chỉ hiện message nên tên người cần sửa phải nằm trong message.
      expect((error as Error).message).toContain('Nguyễn Văn A');
      expect(prisma.payrollPeriod.updateMany).not.toHaveBeenCalled();
    });

    it('rejects opening when there is no ACTIVE reward rule set', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'DRAFT',
      });
      prisma.rewardRuleSet.findFirst.mockResolvedValue(null);
      const auditLog = makeAuditLogMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        auditLog as never,
      );

      await expect(service.open('p1', 'user-admin')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(prisma.payrollPeriod.update).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('syncEmployeeSnapshots — thêm nhân sự mới vào kỳ đã mở', () => {
    it('rejects when the period is not OPEN', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'IN_REVIEW',
      });
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.syncEmployeeSnapshots('p1', 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(
        prisma.payrollPeriodEmployeeSnapshot.createMany,
      ).not.toHaveBeenCalled();
    });

    it('adds only employees missing from the snapshot, leaving existing rows untouched', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'OPEN',
      });
      // e1 đã có snapshot từ trước (lúc mở kỳ); e2 mới được tạo sau đó, chưa có snapshot.
      prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
        { employeeId: 'e1' },
      ]);
      prisma.employee.findMany.mockResolvedValue([
        {
          id: 'e1',
          employeeCode: 'NV-01',
          fullName: 'Nguyễn Văn A',
          jobTitle: 'Editor',
          employeeGroups: [],
          teamId: 't1',
          team: { code: 'TEAM-A', name: 'Team A' },
          leaderEmployeeId: null,
          leader: null,
          managerEmployeeId: null,
          manager: null,
          employmentStatus: 'ACTIVE',
        },
        {
          id: 'e2',
          employeeCode: 'NV-02',
          fullName: 'Lê Văn Ninh',
          jobTitle: 'Content Creator',
          employeeGroups: [{ id: 2, code: 'CONTENT_CREATOR' }],
          teamId: 't2',
          team: { code: 'TEAM-B', name: 'Team K4' },
          leaderEmployeeId: null,
          leader: null,
          managerEmployeeId: null,
          manager: null,
          employmentStatus: 'ACTIVE',
          teamMemberships: [
            {
              id: 'm-e2',
              teamId: 't2',
              team: { code: 'TEAM-B', name: 'Team K4' },
              isPrimary: true,
              defaultSalaryWeightPercent: 100,
              leaderEmployeeId: null,
              leader: null,
              managerEmployeeId: null,
              manager: null,
            },
          ],
        },
      ]);
      const auditLog = makeAuditLogMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        auditLog as never,
      );

      const result = await service.syncEmployeeSnapshots('p1', 'user-admin');

      expect(result).toEqual({
        addedCount: 1,
        addedEmployeeNames: ['Lê Văn Ninh'],
        automaticKpiAssignmentCount: 0,
      });
      const snapshotArg = (
        prisma.payrollPeriodEmployeeSnapshot.createMany.mock.calls[0] as [
          { data: { employeeId: string; employeeCodeSnapshot: string }[] },
        ]
      )[0];
      expect(snapshotArg.data).toHaveLength(1);
      expect(snapshotArg.data[0].employeeId).toBe('e2');
      expect(snapshotArg.data[0].employeeCodeSnapshot).toBe('NV-02');
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'PAYROLL_PERIOD_SNAPSHOTS_SYNCED' }),
      );
    });

    it('no-ops (no write, no audit log) when nothing is missing', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'OPEN',
      });
      prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
        { employeeId: 'e1' },
      ]);
      prisma.employee.findMany.mockResolvedValue([{ id: 'e1' }]);
      const auditLog = makeAuditLogMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        auditLog as never,
      );

      const result = await service.syncEmployeeSnapshots('p1', 'user-admin');

      expect(result).toEqual({
        addedCount: 0,
        addedEmployeeNames: [],
        automaticKpiAssignmentCount: 0,
      });
      expect(
        prisma.payrollPeriodEmployeeSnapshot.createMany,
      ).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe('getEmployeeReadiness — tiền kiểm dữ liệu nhân sự', () => {
    it('kỳ DRAFT: liệt kê từng người chưa đạt điều kiện kèm lý do cụ thể', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'DRAFT',
      });
      prisma.employee.findMany.mockResolvedValue([
        {
          id: 'e1',
          employeeCode: 'NV-01',
          fullName: 'Người đủ điều kiện',
          teamMemberships: [
            { isPrimary: true, defaultSalaryWeightPercent: 100 },
          ],
        },
        {
          id: 'e2',
          employeeCode: 'NV-02',
          fullName: 'Người thiếu tỷ trọng',
          teamMemberships: [
            { isPrimary: true, defaultSalaryWeightPercent: 60 },
          ],
        },
        {
          id: 'e3',
          employeeCode: 'NV-03',
          fullName: 'Người chưa có team',
          teamMemberships: [],
        },
      ]);
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      const result = await service.getEmployeeReadiness('p1' as never);

      expect(result).toMatchObject({
        scope: 'ALL',
        ready: false,
        checkedEmployeeCount: 3,
        invalidEmployeeCount: 2,
      });
      expect(result.employees.map((item) => item.fullName)).toEqual([
        'Người thiếu tỷ trọng',
        'Người chưa có team',
      ]);
      expect(result.employees[0].reasons).toEqual([
        'Tổng tỷ trọng KPI đang là 60%, phải bằng 100%',
      ]);
      expect(result.employees[1].reasons).toEqual([
        'Chưa thuộc team nào đang hoạt động',
      ]);
    });

    it('kỳ OPEN: chỉ soi nhân sự chưa có trong snapshot — đúng tập mà đồng bộ sẽ thêm', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'OPEN',
      });
      prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
        { employeeId: 'e1' },
      ]);
      prisma.employee.findMany.mockResolvedValue([
        {
          id: 'e1',
          employeeCode: 'NV-01',
          fullName: 'Đã snapshot dù đang lệch',
          teamMemberships: [
            { isPrimary: true, defaultSalaryWeightPercent: 60 },
          ],
        },
        {
          id: 'e2',
          employeeCode: 'NV-02',
          fullName: 'Người mới chưa có team chính',
          teamMemberships: [
            { isPrimary: false, defaultSalaryWeightPercent: 100 },
          ],
        },
      ]);
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      const result = await service.getEmployeeReadiness('p1' as never);

      expect(result).toMatchObject({
        scope: 'MISSING',
        ready: false,
        checkedEmployeeCount: 1,
        invalidEmployeeCount: 1,
      });
      expect(result.employees[0]).toMatchObject({
        fullName: 'Người mới chưa có team chính',
        reasons: ['Chưa có team chính'],
      });
    });

    it('kỳ đã qua giai đoạn snapshot: không còn gì để kiểm', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'IN_REVIEW',
      });
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.getEmployeeReadiness('p1' as never),
      ).resolves.toMatchObject({ scope: 'NONE', ready: true, employees: [] });
      expect(prisma.employee.findMany).not.toHaveBeenCalled();
    });
  });

  describe('invalid transitions', () => {
    it('rejects start-review when the period is still DRAFT', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'DRAFT',
      });
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.startReview('p1', 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects close when the period has not reached IN_REVIEW', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'OPEN',
      });
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(service.close('p1', 'user-admin')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('rejects a concurrent start-review after the OPEN row was claimed', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'OPEN',
      });
      prisma.payrollPeriod.updateMany.mockResolvedValue({ count: 0 });
      const auditLog = makeAuditLogMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        auditLog as never,
      );

      await expect(
        service.startReview('p1', 'user-admin'),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it('rejects closing while any employee lacks a locked latest salary', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'IN_REVIEW',
      });
      prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
        { employeeId: 1 },
        { employeeId: 2 },
      ]);
      prisma.salaryRecord.findMany.mockResolvedValue([
        { employeeId: 1, status: 'LOCKED', versionNumber: 1 },
        { employeeId: 2, status: 'WARNING', versionNumber: 1 },
      ]);
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(service.close('p1', 'user-admin')).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { count: 1, employeeIds: [2] },
      });
      expect(prisma.payrollPeriod.updateMany).not.toHaveBeenCalled();
    });

    it('closes when every snapshot employee has a locked latest salary', async () => {
      const prisma = makePrismaMock();
      const closed = { id: 'p1', status: 'CLOSED' };
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'IN_REVIEW',
      });
      prisma.payrollPeriod.findUniqueOrThrow.mockResolvedValue(closed);
      prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
        { employeeId: 1 },
      ]);
      prisma.salaryRecord.findMany.mockResolvedValue([
        { employeeId: 1, status: 'LOCKED', versionNumber: 2 },
        { employeeId: 1, status: 'SUPERSEDED', versionNumber: 1 },
      ]);
      const service = new PayrollPeriodsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(service.close('p1', 'user-admin')).resolves.toBe(closed);
      expect(prisma.payrollPeriod.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p1', status: 'IN_REVIEW' },
        }),
      );
    });

    it('rejects a concurrent close after readiness checks if the row was claimed', async () => {
      const prisma = makePrismaMock();
      prisma.payrollPeriod.findUnique.mockResolvedValue({
        id: 'p1',
        status: 'IN_REVIEW',
      });
      prisma.payrollPeriodEmployeeSnapshot.findMany.mockResolvedValue([
        { employeeId: 1 },
      ]);
      prisma.salaryRecord.findMany.mockResolvedValue([
        { employeeId: 1, status: 'LOCKED', versionNumber: 1 },
      ]);
      prisma.payrollPeriod.updateMany.mockResolvedValue({ count: 0 });
      const auditLog = makeAuditLogMock();
      const service = new PayrollPeriodsService(
        prisma as never,
        auditLog as never,
      );

      await expect(service.close('p1', 'user-admin')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });
});
