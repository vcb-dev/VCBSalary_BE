import { EmployeeGroupsService } from '../employee-groups.service';

function makePrismaMock() {
  return {
    employeeGroup: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _max: { id: 0 } }),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    department: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    role: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    employee: { count: jest.fn().mockResolvedValue(0) },
    kpiGroup: { count: jest.fn().mockResolvedValue(0) },
  };
}

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    code: 'EG-0001',
    name: 'Editor',
    departmentId: 1,
    defaultRoleId: null,
    status: 'ACTIVE',
    _count: { employees: 0, kpiGroups: 0 },
    ...overrides,
  };
}

function firstCallArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0]?.[0] as T;
}

describe('EmployeeGroupsService', () => {
  describe('list', () => {
    it('kèm nhóm dùng chung khi lọc theo phòng ban', async () => {
      const prisma = makePrismaMock();
      const service = new EmployeeGroupsService(prisma as never);

      await service.list({ departmentId: 7 });

      const query = firstCallArg<{
        where: { OR: Array<{ departmentId: number | null }> };
      }>(prisma.employeeGroup.findMany);
      expect(query.where.OR).toEqual([
        { departmentId: 7 },
        { departmentId: null },
      ]);
    });
  });

  describe('create', () => {
    it('tự sinh code và chuẩn hóa từ khóa chức danh (bỏ dấu, viết hoa, khử trùng)', async () => {
      const prisma = makePrismaMock();
      prisma.employeeGroup.aggregate.mockResolvedValue({ _max: { id: 4 } });
      prisma.employeeGroup.create.mockResolvedValue(makeGroup());
      const service = new EmployeeGroupsService(prisma as never);

      await service.create({
        name: 'Kế toán viên',
        departmentId: 2,
        jobTitleKeywords: ['Kế toán', 'ke toan', 'Thủ quỹ'],
      });

      const createArg = firstCallArg<{
        data: { code: string; jobTitleKeywords: string[] };
      }>(prisma.employeeGroup.create);
      expect(createArg.data.code).toBe('EG-0005');
      expect(createArg.data.jobTitleKeywords).toEqual(['KE TOAN', 'THU QUY']);
    });

    it('từ chối departmentId không tồn tại', async () => {
      const prisma = makePrismaMock();
      prisma.department.findUnique.mockResolvedValue(null);
      const service = new EmployeeGroupsService(prisma as never);

      await expect(
        service.create({ name: 'Kế toán viên', departmentId: 99 }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.employeeGroup.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('chặn chuyển phòng ban khi còn nhân sự phòng ban cũ đang dùng nhóm', async () => {
      const prisma = makePrismaMock();
      prisma.employeeGroup.findUnique.mockResolvedValue(makeGroup());
      prisma.employee.count.mockResolvedValue(3);
      const service = new EmployeeGroupsService(prisma as never);

      await expect(
        service.update(1, { departmentId: 2 }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(prisma.employeeGroup.update).not.toHaveBeenCalled();
    });

    it('cho phép chuyển sang nhóm dùng chung (departmentId = null) mà không cần kiểm tra', async () => {
      const prisma = makePrismaMock();
      prisma.employeeGroup.findUnique.mockResolvedValue(makeGroup());
      prisma.employee.count.mockResolvedValue(3);
      prisma.employeeGroup.update.mockResolvedValue(
        makeGroup({ departmentId: null }),
      );
      const service = new EmployeeGroupsService(prisma as never);

      await expect(
        service.update(1, { departmentId: null }),
      ).resolves.toMatchObject({ departmentId: null });
    });
  });

  describe('remove', () => {
    it('chặn xóa nhóm đang được nhân sự hoặc nhóm KPI dùng', async () => {
      const prisma = makePrismaMock();
      prisma.employeeGroup.findUnique.mockResolvedValue(
        makeGroup({ _count: { employees: 2, kpiGroups: 1 } }),
      );
      const service = new EmployeeGroupsService(prisma as never);

      await expect(service.remove(1)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(prisma.employeeGroup.delete).not.toHaveBeenCalled();
    });

    it('xóa được nhóm chưa gán ở đâu', async () => {
      const prisma = makePrismaMock();
      prisma.employeeGroup.findUnique.mockResolvedValue(makeGroup());
      const service = new EmployeeGroupsService(prisma as never);

      await service.remove(1);

      expect(prisma.employeeGroup.delete).toHaveBeenCalledWith({
        where: { id: 1 },
      });
    });
  });
});
