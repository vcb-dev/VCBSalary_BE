import { KpiGroupsService } from '../kpi-groups.service';
import { KpiDataSource } from '@prisma/client';

interface PrismaMock {
  kpiGroup: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    aggregate: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  kpiItem: {
    findUnique: jest.Mock;
    create: jest.Mock;
    aggregate: jest.Mock;
    update: jest.Mock;
    deleteMany: jest.Mock;
  };
  employeeKpiAssignment: { count: jest.Mock };
  kpiPeriodTarget: { count: jest.Mock };
  employeeKpiActual: { count: jest.Mock };
  employeeKpiRewardRate: { count: jest.Mock };
  kpiOkrProposal: { count: jest.Mock };
  team: { count: jest.Mock; findMany: jest.Mock };
  employeeGroup: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

function makePrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    kpiGroup: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _max: { id: 0 } }),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    kpiItem: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _max: { id: 0 } }),
      update: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    employeeKpiAssignment: { count: jest.fn().mockResolvedValue(0) },
    kpiPeriodTarget: { count: jest.fn().mockResolvedValue(0) },
    employeeKpiActual: { count: jest.fn().mockResolvedValue(0) },
    employeeKpiRewardRate: { count: jest.fn().mockResolvedValue(0) },
    kpiOkrProposal: { count: jest.fn().mockResolvedValue(0) },
    team: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    employeeGroup: { findMany: jest.fn().mockResolvedValue([]) },
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

function makeAuthorizationMock(
  scope: { type: 'ALL' } | { type: 'TEAM'; teamIds: string[] } = {
    type: 'ALL',
  },
) {
  return {
    resolveScope: jest.fn().mockResolvedValue(scope),
    resolvePermissionScope: jest.fn().mockResolvedValue(scope),
  };
}

describe('KpiGroupsService', () => {
  describe('create', () => {
    it('rejects AutomationGenVideo until the KPI sync flow is implemented', async () => {
      const prisma = makePrismaMock();
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.create(
          {
            code: 'AUTO',
            name: 'Đồng bộ tự động',
            dataSource: KpiDataSource.AUTOMATION_GEN_VIDEO,
          },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.kpiGroup.create).not.toHaveBeenCalled();
    });

    it('requires at least one team for a manually created group', async () => {
      const prisma = makePrismaMock();
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.create({ name: 'Sản xuất content', teamIds: [] }, 'user-admin'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('creates one KPI group connected to every selected team', async () => {
      const prisma = makePrismaMock();
      prisma.team.findMany.mockResolvedValue([
        { id: 1, departmentId: 1 },
        { id: 2, departmentId: 1 },
      ]);
      prisma.kpiGroup.create.mockResolvedValue({
        id: 'g1',
        code: 'CONTENT',
        name: 'Sản xuất content',
        applicableEmployeeGroups: [],
      });
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await service.create(
        {
          name: 'Sản xuất content',
          teamIds: [1, 2],
        },
        'user-admin',
      );

      const create = firstCallArg<{
        data: { teams: { createMany: { data: Array<{ teamId: number }> } } };
      }>(prisma.kpiGroup.create);
      expect(create.data.teams.createMany.data).toEqual([
        { teamId: 1 },
        { teamId: 2 },
      ]);
    });

    it('does not let a leader configure a group for a team outside their scope', async () => {
      const prisma = makePrismaMock();
      prisma.team.findMany.mockResolvedValue([
        { id: 'team-mine', departmentId: 1 },
        { id: 'team-other', departmentId: 1 },
      ]);
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock({
          type: 'TEAM',
          teamIds: ['team-mine'],
        }) as never,
      );

      await expect(
        service.create(
          {
            code: 'CONTENT',
            name: 'Sản xuất content',
            teamIds: ['team-mine', 'team-other'],
          },
          'leader-user',
        ),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
      expect(prisma.kpiGroup.create).not.toHaveBeenCalled();
    });
  });

  describe('nhóm nghiệp vụ tự gán', () => {
    it('từ chối nhóm nghiệp vụ thuộc phòng ban khác với team của nhóm KPI', async () => {
      const prisma = makePrismaMock();
      prisma.team.findMany.mockResolvedValue([{ id: 1, departmentId: 1 }]);
      prisma.employeeGroup.findMany.mockResolvedValue([
        { id: 30, name: 'Kế toán viên', status: 'ACTIVE', departmentId: 2 },
      ]);
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.create(
          {
            name: 'Sản xuất content',
            teamIds: [1],
            applicableEmployeeGroupIds: [30],
          },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.kpiGroup.create).not.toHaveBeenCalled();
    });

    it('nối nhóm nghiệp vụ cùng phòng ban khi tạo nhóm KPI', async () => {
      const prisma = makePrismaMock();
      prisma.team.findMany.mockResolvedValue([{ id: 1, departmentId: 1 }]);
      prisma.employeeGroup.findMany.mockResolvedValue([
        { id: 10, name: 'Editor', status: 'ACTIVE', departmentId: 1 },
      ]);
      prisma.kpiGroup.create.mockResolvedValue({
        id: 'g1',
        code: 'CONTENT',
        applicableEmployeeGroups: [],
      });
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await service.create(
        {
          name: 'Sản xuất content',
          teamIds: [1],
          applicableEmployeeGroupIds: [10],
        },
        'user-admin',
      );

      const create = firstCallArg<{
        data: {
          applicableEmployeeGroups: {
            createMany: { data: Array<{ employeeGroupId: number }> };
          };
        };
      }>(prisma.kpiGroup.create);
      expect(create.data.applicableEmployeeGroups.createMany.data).toEqual([
        { employeeGroupId: 10 },
      ]);
    });
  });

  describe('update', () => {
    it('allows updating metadata of an existing AutomationGenVideo group', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 1,
        code: 'CONTENT',
        name: 'Tên cũ',
        dataSource: KpiDataSource.AUTOMATION_GEN_VIDEO,
        teams: [],
        applicableEmployeeGroups: [],
      });
      prisma.kpiGroup.update.mockResolvedValue({
        id: 1,
        name: 'Tên mới',
        applicableEmployeeGroups: [],
      });
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.update(
          1,
          {
            name: 'Tên mới',
            dataSource: KpiDataSource.AUTOMATION_GEN_VIDEO,
          },
          'user-admin',
        ),
      ).resolves.toMatchObject({ name: 'Tên mới' });
    });

    it('keeps the generated code when updating metadata', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 1,
        code: 'KPI-G-00001',
        name: 'Nhóm cũ',
        teams: [],
        applicableEmployeeGroups: [],
      });
      prisma.kpiGroup.update.mockResolvedValue({
        id: 1,
        code: 'KPI-G-00001',
        name: 'Tên mới',
        applicableEmployeeGroups: [],
      });
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await service.update(1, { name: 'Tên mới' }, 'user-admin');
      const update = firstCallArg<{ data: Record<string, unknown> }>(
        prisma.kpiGroup.update,
      );
      expect(update.data).not.toHaveProperty('code');
    });

    it('thay danh sách team bằng đúng tập id mới trên bảng nối', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 1,
        code: 'KPI-G-00001',
        name: 'Nhóm cũ',
        teams: [{ teamId: 1, team: { departmentId: 1 } }],
        applicableEmployeeGroups: [],
      });
      prisma.team.findMany.mockResolvedValue([
        { id: 1, departmentId: 1 },
        { id: 2, departmentId: 1 },
      ]);
      prisma.kpiGroup.update.mockResolvedValue({
        id: 1,
        applicableEmployeeGroups: [],
      });
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await service.update(1, { teamIds: [1, 2] }, 'user-admin');

      const update = firstCallArg<{ data: { teams: unknown } }>(
        prisma.kpiGroup.update,
      );
      expect(update.data.teams).toEqual({
        deleteMany: { teamId: { notIn: [1, 2] } },
        createMany: {
          data: [{ teamId: 1 }, { teamId: 2 }],
          skipDuplicates: true,
        },
      });
    });
  });

  describe('getOrThrow', () => {
    it('trả team và nhóm nghiệp vụ dạng mảng phẳng như trước khi tách bảng nối', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 1,
        teams: [{ team: { id: 2, code: 'K2', name: 'Team K2' } }],
        applicableEmployeeGroups: [
          { employeeGroup: { id: 10, code: 'EDITOR', name: 'Editor' } },
        ],
        items: [],
      });
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await expect(service.getOrThrow(1)).resolves.toMatchObject({
        teams: [{ id: 2, code: 'K2', name: 'Team K2' }],
        applicableEmployeeGroups: [{ id: 10, code: 'EDITOR', name: 'Editor' }],
      });
    });

    it('rejects updating a group that does not exist', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue(null);
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.update('unknown', { name: 'x' }, 'user-admin'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('createItem', () => {
    it('rejects when the parent group does not exist', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue(null);
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.createItem(
          'unknown',
          { code: 'VIEWS', name: 'Views', unit: 'views' },
          'user-admin',
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('generates an item code automatically', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 1,
        teams: [],
        applicableEmployeeGroups: [],
      });
      prisma.kpiItem.create.mockResolvedValue({
        id: 1,
        code: 'KPI-I-000001',
        name: 'Views',
      });
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await service.createItem(
        1,
        { name: 'Views', unit: 'views' },
        'user-admin',
      );
      const create = firstCallArg<{ data: { code: string } }>(
        prisma.kpiItem.create,
      );
      expect(create.data.code).toBe('KPI-I-000001');
    });

    it('creates an item and records an audit entry', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({ id: 'g1' });
      prisma.kpiItem.create.mockResolvedValue({
        id: 'item-1',
        code: 'VIEWS',
        name: 'Views',
      });
      const auditLog = makeAuditLogMock();
      const service = new KpiGroupsService(
        prisma as never,
        auditLog as never,
        makeAuthorizationMock() as never,
      );

      await service.createItem(
        'g1',
        { code: 'VIEWS', name: 'Views', unit: 'views' },
        'user-admin',
      );

      const createArg = (
        prisma.kpiItem.create.mock.calls[0] as [
          { data: { kpiGroupId: string; code: string } },
        ]
      )[0];
      expect(createArg.data.kpiGroupId).toBe('g1');
      expect(createArg.data.code).toBe('KPI-I-000001');
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'KPI_ITEM_CREATED' }),
      );
    });
  });

  describe('remove', () => {
    it('rejects removing a group that does not exist', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue(null);
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await expect(
        service.remove('unknown', 'user-admin'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects removing a group that already has business data', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 'g1',
        code: 'CONTENT',
        name: 'Sản xuất content',
        isActive: true,
        applicableEmployeeGroups: [],
      });
      prisma.employeeKpiAssignment.count.mockResolvedValue(3);
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
        makeAuthorizationMock() as never,
      );

      await expect(service.remove('g1', 'user-admin')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(prisma.kpiGroup.delete).not.toHaveBeenCalled();
    });

    it('deletes an unused group with its items and records an audit entry', async () => {
      const prisma = makePrismaMock();
      prisma.kpiGroup.findUnique.mockResolvedValue({
        id: 'g1',
        code: 'CONTENT',
        name: 'Sản xuất content',
        isActive: true,
        applicableEmployeeGroups: [],
      });
      const auditLog = makeAuditLogMock();
      const service = new KpiGroupsService(
        prisma as never,
        auditLog as never,
        makeAuthorizationMock() as never,
      );

      await service.remove('g1', 'user-admin');

      expect(prisma.kpiItem.deleteMany).toHaveBeenCalledWith({
        where: { kpiGroupId: 'g1' },
      });
      expect(prisma.kpiGroup.delete).toHaveBeenCalledWith({
        where: { id: 'g1' },
      });
      expect(auditLog.record).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ action: 'KPI_GROUP_DELETED' }),
      );
    });
  });

  describe('updateItem', () => {
    it('rejects updating an item that does not exist', async () => {
      const prisma = makePrismaMock();
      prisma.kpiItem.findUnique.mockResolvedValue(null);
      const service = new KpiGroupsService(
        prisma as never,
        makeAuditLogMock() as never,
      );

      await expect(
        service.updateItem('unknown', { isActive: false }, 'user-admin'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('disables an item without deleting it', async () => {
      const prisma = makePrismaMock();
      prisma.kpiItem.findUnique.mockResolvedValue({
        id: 'item-1',
        name: 'Views',
        unit: 'views',
        isActive: true,
      });
      prisma.kpiItem.update.mockResolvedValue({
        id: 'item-1',
        isActive: false,
      });
      const auditLog = makeAuditLogMock();
      const service = new KpiGroupsService(
        prisma as never,
        auditLog as never,
        makeAuthorizationMock() as never,
      );

      await service.updateItem('item-1', { isActive: false }, 'user-admin');

      const updateArg = (
        prisma.kpiItem.update.mock.calls[0] as [
          { where: { id: string }; data: { isActive: boolean } },
        ]
      )[0];
      expect(updateArg.where).toEqual({ id: 'item-1' });
      expect(updateArg.data.isActive).toBe(false);
    });
  });
});
