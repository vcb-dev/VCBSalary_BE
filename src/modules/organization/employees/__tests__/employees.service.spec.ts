import { EmployeesService } from '../employees.service';

function makePrismaMock() {
  const mock = {
    team: { findUnique: jest.fn() },
    employeeGroup: { findMany: jest.fn().mockResolvedValue([]) },
    employee: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _max: { id: 0 } }),
      create: jest.fn(),
      update: jest.fn(),
    },
    employeeTeamMembership: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: typeof mock) => unknown)(mock);
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
  return mock;
}

type MembershipUpdateArg = {
  where: { id: number };
  data: { isPrimary?: boolean; defaultSalaryWeightPercent?: unknown };
};

/** Lấy lệnh update ghi vào một membership cụ thể, bất kể thứ tự các lệnh khác. */
function membershipUpdateOn(
  prisma: ReturnType<typeof makePrismaMock>,
  membershipId: number,
) {
  return (prisma.employeeTeamMembership.update.mock.calls as unknown[][])
    .map((call) => call[0] as MembershipUpdateArg)
    .find((arg) => arg.where.id === membershipId);
}

/**
 * deactivateMembership đọc membership hai lần với hai bộ lọc khác nhau: danh sách team còn lại
 * (`teamId: { not }`) và các team phụ để tính lại tỷ trọng (`id: { not }`). Mock tách theo bộ lọc
 * để test mô tả đúng dữ liệu thật thay vì phụ thuộc thứ tự gọi.
 */
function stubMembershipQueries(
  prisma: ReturnType<typeof makePrismaMock>,
  { alternatives, others }: { alternatives: unknown[]; others: unknown[] },
) {
  prisma.employeeTeamMembership.findMany.mockImplementation(
    (args: { where?: { teamId?: unknown } }) =>
      Promise.resolve(args?.where?.teamId ? alternatives : others),
  );
}

function makeAuthorizationMock() {
  return {
    resolveScope: jest.fn(),
    getEmployeeId: jest.fn(),
  };
}

function firstCallArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0]?.[0] as T;
}

describe('EmployeesService', () => {
  describe('list', () => {
    /** Trả về mệnh đề lọc (phần sau scope) mà `list` dựng ra cho Prisma. */
    async function filterWhereFor(query: Record<string, unknown>) {
      const prisma = makePrismaMock();
      const authorization = makeAuthorizationMock();
      authorization.resolveScope.mockResolvedValue({ type: 'ALL' });
      const service = new EmployeesService(
        prisma as never,
        authorization as never,
      );

      await service.list('user-1', { page: 1, pageSize: 20, ...query });

      const args = firstCallArg<{
        where: { AND: Record<string, unknown>[] };
      }>(prisma.employee.findMany);
      return args.where.AND[1];
    }

    it('bỏ nhân sự đã nghỉ khi excludeLeft được bật', async () => {
      await expect(
        filterWhereFor({ excludeLeft: true }),
      ).resolves.toMatchObject({ employmentStatus: { not: 'LEFT' } });
    });

    it('ưu tiên employmentStatus cụ thể hơn excludeLeft', async () => {
      await expect(
        filterWhereFor({ excludeLeft: true, employmentStatus: 'LEFT' }),
      ).resolves.toMatchObject({ employmentStatus: 'LEFT' });
    });

    it('không lọc trạng thái làm việc khi không truyền cờ nào', async () => {
      const where = await filterWhereFor({});
      expect(where.employmentStatus).toBeUndefined();
    });
  });

  describe('create', () => {
    it('rejects when teamId does not exist', async () => {
      const prisma = makePrismaMock();
      prisma.team.findUnique.mockResolvedValue(null);
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.create({
          employeeCode: 'E1',
          fullName: 'A',
          jobTitle: 'Editor',
          teamId: 'missing-team',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects when leaderEmployeeId does not reference an existing employee', async () => {
      const prisma = makePrismaMock();
      prisma.team.findUnique.mockResolvedValue({
        id: 'team-1',
        departmentId: 1,
      });
      prisma.employee.findMany.mockResolvedValue([]);
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.create({
          employeeCode: 'E1',
          fullName: 'A',
          jobTitle: 'Editor',
          teamId: 'team-1',
          leaderEmployeeId: 'ghost-employee',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('generates employeeCode automatically', async () => {
      const prisma = makePrismaMock();
      prisma.team.findUnique.mockResolvedValue({
        id: 'team-1',
        departmentId: 1,
      });
      prisma.employee.create.mockResolvedValue({
        id: 1,
        employeeCode: 'NV-000001',
      });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.create({
          fullName: 'A',
          jobTitle: 'Editor',
          teamId: 1,
        }),
      ).resolves.toMatchObject({ employeeCode: 'NV-000001' });
    });
  });

  describe('nhóm nghiệp vụ theo danh mục', () => {
    it('đoán nhóm từ chức danh bằng từ khóa của nhóm trong đúng phòng ban', async () => {
      const prisma = makePrismaMock();
      prisma.team.findUnique.mockResolvedValue({ id: 1, departmentId: 7 });
      prisma.employeeGroup.findMany.mockResolvedValue([
        { id: 10, jobTitleKeywords: ['EDITOR', 'DUNG PHIM'] },
        { id: 11, jobTitleKeywords: ['KE TOAN'] },
        { id: 12, jobTitleKeywords: [] },
      ]);
      prisma.employee.create.mockResolvedValue({ id: 1 });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await service.create({
        fullName: 'A',
        jobTitle: 'Nhân viên dựng phim',
        teamId: 1,
      });

      const createArg = firstCallArg<{
        data: { employeeGroups: { connect: { id: number }[] } };
      }>(prisma.employee.create);
      expect(createArg.data.employeeGroups.connect).toEqual([{ id: 10 }]);
      const groupQuery = firstCallArg<{
        where: { OR: Array<{ departmentId: number | null }> };
      }>(prisma.employeeGroup.findMany);
      expect(groupQuery.where.OR).toEqual([
        { departmentId: 7 },
        { departmentId: null },
      ]);
    });

    it('từ chối nhóm nghiệp vụ thuộc phòng ban khác', async () => {
      const prisma = makePrismaMock();
      prisma.team.findUnique.mockResolvedValue({ id: 1, departmentId: 7 });
      prisma.employeeGroup.findMany.mockResolvedValue([
        { id: 20, name: 'Kế toán viên', status: 'ACTIVE', departmentId: 9 },
      ]);
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.create({
          fullName: 'A',
          jobTitle: 'Editor',
          teamId: 1,
          employeeGroupIds: [20],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.employee.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects when leaderEmployeeId equals the employee itself', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 'emp-1',
        employmentStatus: 'ACTIVE',
      });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.update('emp-1', { leaderEmployeeId: 'emp-1' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects when managerEmployeeId equals the employee itself', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 'emp-1',
        employmentStatus: 'ACTIVE',
      });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.update('emp-1', { managerEmployeeId: 'emp-1' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('auto-sets leftAt when transitioning to LEFT without an explicit date', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 'emp-1',
        employmentStatus: 'ACTIVE',
      });
      prisma.employee.update.mockResolvedValue({ id: 'emp-1' });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await service.update('emp-1', { employmentStatus: 'LEFT' });

      const updateMock = prisma.employee.update as jest.Mock<
        unknown,
        [{ data: { leftAt?: Date } }]
      >;
      expect(updateMock.mock.calls[0][0].data.leftAt).toBeInstanceOf(Date);
    });

    it('clears leftAt when reactivating an employee who previously left', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 1,
        employmentStatus: 'LEFT',
        leftAt: new Date('2026-01-01'),
      });
      prisma.employee.update.mockResolvedValue({ id: 1 });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await service.update(1, { employmentStatus: 'ACTIVE' });

      const update = firstCallArg<{ data: { leftAt: Date | null } }>(
        prisma.employee.update,
      );
      expect(update.data.leftAt).toBeNull();
    });

    it('allows clearing nullable hierarchy and profile fields', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 1,
        employmentStatus: 'ACTIVE',
      });
      prisma.employee.update.mockResolvedValue({ id: 1 });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await service.update(1, {
        leaderEmployeeId: null,
        managerEmployeeId: null,
        joinedAt: null,
      });

      expect(prisma.employee.findMany).not.toHaveBeenCalled();
      const update = firstCallArg<{
        data: {
          leaderEmployeeId: string | null;
          managerEmployeeId: string | null;
          joinedAt: Date | null;
        };
      }>(prisma.employee.update);
      expect(update.data).toMatchObject({
        leaderEmployeeId: null,
        managerEmployeeId: null,
        joinedAt: null,
      });
    });
  });

  describe('deactivateMembership — giữ tổng tỷ trọng KPI đúng 100%', () => {
    it('dồn tỷ trọng của team bị gỡ về team chính đang có', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({ id: 1, teamId: 1 });
      prisma.employeeTeamMembership.findUnique.mockResolvedValue({
        id: 2,
        employeeId: 1,
        teamId: 2,
        isPrimary: false,
        isActive: true,
        defaultSalaryWeightPercent: 40,
      });
      stubMembershipQueries(prisma, {
        alternatives: [
          {
            id: 1,
            teamId: 1,
            isPrimary: true,
            defaultSalaryWeightPercent: 60,
            leaderEmployeeId: null,
            managerEmployeeId: null,
          },
        ],
        others: [],
      });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await service.deactivateMembership(1, 2, 'user-admin');

      const rebalance = membershipUpdateOn(prisma, 1);
      expect(String(rebalance?.data.defaultSalaryWeightPercent)).toBe('100');
      expect(rebalance?.data.isPrimary).toBe(true);
      // Chỉ gỡ team phụ nên team chính không đổi -> không đụng vào bản ghi nhân sự.
      expect(prisma.employee.update).not.toHaveBeenCalled();
    });

    it('gỡ team chính: team nặng nhất còn lại lên thay và nhận phần tỷ trọng còn thiếu', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({ id: 1, teamId: 1 });
      prisma.employeeTeamMembership.findUnique.mockResolvedValue({
        id: 1,
        employeeId: 1,
        teamId: 1,
        isPrimary: true,
        isActive: true,
        defaultSalaryWeightPercent: 50,
      });
      stubMembershipQueries(prisma, {
        alternatives: [
          {
            id: 2,
            teamId: 2,
            isPrimary: false,
            defaultSalaryWeightPercent: 30,
            leaderEmployeeId: 9,
            managerEmployeeId: 8,
          },
          {
            id: 3,
            teamId: 3,
            isPrimary: false,
            defaultSalaryWeightPercent: 20,
            leaderEmployeeId: null,
            managerEmployeeId: null,
          },
        ],
        others: [{ defaultSalaryWeightPercent: 20 }],
      });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await service.deactivateMembership(1, 1, 'user-admin');

      const rebalance = membershipUpdateOn(prisma, 2);
      expect(rebalance?.data.isPrimary).toBe(true);
      expect(String(rebalance?.data.defaultSalaryWeightPercent)).toBe('80');
      // Team chính đổi thì bản ghi nhân sự phải trỏ theo team + leader/manager của team mới.
      const employeeUpdate = firstCallArg<{
        data: {
          teamId: number;
          leaderEmployeeId: number | null;
          managerEmployeeId: number | null;
        };
      }>(prisma.employee.update);
      expect(employeeUpdate.data.teamId).toBe(2);
      expect(employeeUpdate.data.leaderEmployeeId).toBe(9);
      expect(employeeUpdate.data.managerEmployeeId).toBe(8);
    });

    it('vẫn chặn khi gỡ team hoạt động cuối cùng', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({ id: 1, teamId: 1 });
      prisma.employeeTeamMembership.findUnique.mockResolvedValue({
        id: 1,
        employeeId: 1,
        teamId: 1,
        isPrimary: true,
        isActive: true,
        defaultSalaryWeightPercent: 100,
      });
      stubMembershipQueries(prisma, { alternatives: [], others: [] });
      const service = new EmployeesService(
        prisma as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.deactivateMembership(1, 1, 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.employeeTeamMembership.update).not.toHaveBeenCalled();
    });
  });

  describe('getOne', () => {
    it('allows access under ALL scope', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 'emp-1',
        teamId: 'team-1',
      });
      const authorization = makeAuthorizationMock();
      authorization.resolveScope.mockResolvedValue({ type: 'ALL' });
      const service = new EmployeesService(
        prisma as never,
        authorization as never,
      );

      await expect(service.getOne('user-1', 'emp-1')).resolves.toMatchObject({
        id: 'emp-1',
      });
    });

    it('blocks access under TEAM scope when the employee is in a different team', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 'emp-1',
        teamId: 'team-other',
      });
      const authorization = makeAuthorizationMock();
      authorization.resolveScope.mockResolvedValue({
        type: 'TEAM',
        teamIds: ['team-1'],
      });
      const service = new EmployeesService(
        prisma as never,
        authorization as never,
      );

      await expect(service.getOne('user-1', 'emp-1')).rejects.toMatchObject({
        code: 'OUT_OF_SCOPE',
      });
    });

    it('blocks access under SELF scope for someone else’s employee record', async () => {
      const prisma = makePrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 'emp-1',
        teamId: 'team-1',
      });
      const authorization = makeAuthorizationMock();
      authorization.resolveScope.mockResolvedValue({ type: 'SELF' });
      authorization.getEmployeeId.mockResolvedValue('emp-2');
      const service = new EmployeesService(
        prisma as never,
        authorization as never,
      );

      await expect(service.getOne('user-1', 'emp-1')).rejects.toMatchObject({
        code: 'OUT_OF_SCOPE',
      });
    });
  });
});
