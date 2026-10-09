import { runInRequestContext } from '../../../common/request-context';
import { AuthorizationService } from '../authorization.service';
import type { ResolvedScope } from '../../../common/types/resolved-scope.types';
import { PeriodScopeService } from '../period-scope.service';
import { RolesService } from '../roles/roles.service';
import { UsersService } from '../users/users.service';

/* ==========================================================================
 * AuthorizationService — phân giải permission và data scope
 * ========================================================================== */

type FakeGrant = {
  scopeType: 'SELF' | 'TEAM' | 'ALL';
  scopeTeamId: number | null;
  role: {
    rolePermissions: { permission: { code: string } }[];
  };
};

function makeGrant(
  codes: string[],
  scopeTeamId: number | null = null,
  scopeType: FakeGrant['scopeType'] = codes.some((code) =>
    code.endsWith('_all'),
  )
    ? 'ALL'
    : codes.some((code) => code.endsWith('_team'))
      ? 'TEAM'
      : 'SELF',
): FakeGrant {
  return {
    scopeType,
    scopeTeamId,
    role: {
      rolePermissions: codes.map((code) => ({ permission: { code } })),
    },
  };
}

function serviceWithGrants(
  grants: FakeGrant[],
  employeeId: number | null = null,
) {
  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'u1', employeeId, userRoles: grants }),
    },
  };
  return new AuthorizationService(prisma as never);
}

function accessProfileLookup(service: AuthorizationService): jest.Mock {
  return (service as unknown as { prisma: { user: { findUnique: jest.Mock } } })
    .prisma.user.findUnique;
}

describe('AuthorizationService', () => {
  describe('hasPermission', () => {
    it('grants when the permission code is present', async () => {
      const service = serviceWithGrants([makeGrant(['kpi.view_self'])]);
      await expect(service.hasPermission('u1', 'kpi.view_self')).resolves.toBe(
        true,
      );
    });

    it('denies when the permission code is absent', async () => {
      const service = serviceWithGrants([makeGrant(['kpi.view_self'])]);
      await expect(service.hasPermission('u1', 'kpi.override')).resolves.toBe(
        false,
      );
    });

    it('denies a user with no role assignments', async () => {
      const service = serviceWithGrants([]);
      await expect(service.hasPermission('u1', 'kpi.view_self')).resolves.toBe(
        false,
      );
    });
  });

  describe('resolveScope', () => {
    it('resolves SELF scope for an individual-contributor style grant', async () => {
      const service = serviceWithGrants([makeGrant(['kpi.view_self'])]);
      await expect(service.resolveScope('u1', 'kpi')).resolves.toEqual({
        type: 'SELF',
      });
    });

    it('resolves TEAM scope and collects the granting team id', async () => {
      const service = serviceWithGrants([makeGrant(['kpi.view_team'], 1)]);
      await expect(service.resolveScope('u1', 'kpi')).resolves.toEqual({
        type: 'TEAM',
        teamIds: [1],
      });
    });

    it('resolves ALL scope for an admin-style grant', async () => {
      const service = serviceWithGrants([makeGrant(['kpi.view_all'])]);
      await expect(service.resolveScope('u1', 'kpi')).resolves.toEqual({
        type: 'ALL',
      });
    });

    it('returns NONE when the user holds no permission for that resource', async () => {
      const service = serviceWithGrants([makeGrant(['revenue.write'])]);
      await expect(service.resolveScope('u1', 'kpi')).resolves.toEqual({
        type: 'NONE',
      });
    });

    it('does not treat a non-view permission with a scope-like suffix as view access', async () => {
      const service = serviceWithGrants([makeGrant(['kpi.override_all'])]);
      await expect(service.resolveScope('u1', 'kpi')).resolves.toEqual({
        type: 'NONE',
      });
    });

    it('widens to ALL when a custom role combines TEAM and ALL grants', async () => {
      const service = serviceWithGrants([
        makeGrant(['kpi.view_team'], 1),
        makeGrant(['kpi.view_all']),
      ]);
      await expect(service.resolveScope('u1', 'kpi')).resolves.toEqual({
        type: 'ALL',
      });
    });

    it('merges team ids across multiple TEAM-scoped grants', async () => {
      const service = serviceWithGrants([
        makeGrant(['kpi.view_team'], 1),
        makeGrant(['kpi.view_team'], 2),
      ]);
      const result = await service.resolveScope('u1', 'kpi');
      expect(result.type).toBe('TEAM');
      expect(result.type === 'TEAM' && [...result.teamIds].sort()).toEqual([
        1, 2,
      ]);
    });

    it('caps a view_all permission at the SELF scope of its role assignment', async () => {
      const service = serviceWithGrants([
        makeGrant(['employee.view_all'], null, 'SELF'),
      ]);
      await expect(service.resolveScope('u1', 'employee')).resolves.toEqual({
        type: 'SELF',
      });
    });

    it('does not infer a team when view_team is assigned with ALL and no team id', async () => {
      const service = serviceWithGrants([
        makeGrant(['kpi.view_team'], null, 'ALL'),
      ]);
      await expect(service.resolveScope('u1', 'kpi')).resolves.toEqual({
        type: 'NONE',
      });
    });
  });

  describe('resolvePermissionScope', () => {
    it('uses only grants containing the requested action permission', async () => {
      const service = serviceWithGrants([
        makeGrant(['traffic.write_team'], 1, 'TEAM'),
        makeGrant(['traffic.view_team'], 2, 'TEAM'),
      ]);
      await expect(
        service.resolvePermissionScope('u1', 'traffic.write_team'),
      ).resolves.toEqual({ type: 'TEAM', teamIds: [1] });
    });

    it('supports an ALL-scoped custom action without a companion view permission', async () => {
      const service = serviceWithGrants([
        makeGrant(['kpi.leader_approve'], null, 'ALL'),
      ]);
      await expect(
        service.resolvePermissionScope('u1', 'kpi.leader_approve'),
      ).resolves.toEqual({ type: 'ALL' });
    });
  });

  describe('per-request access profile', () => {
    it('loads roles and employeeId once for every check in the same request', async () => {
      const service = serviceWithGrants([makeGrant(['kpi.view_team'], 3)], 42);

      await runInRequestContext(async () => {
        await service.hasAnyPermission('u1', ['kpi.view_team']);
        await expect(service.resolveScope('u1', 'kpi')).resolves.toEqual({
          type: 'TEAM',
          teamIds: [3],
        });
        await expect(service.getEmployeeId('u1')).resolves.toBe(42);
      });

      expect(accessProfileLookup(service)).toHaveBeenCalledTimes(1);
    });

    it('never reuses a profile across requests or outside a request', async () => {
      const service = serviceWithGrants([makeGrant(['kpi.view_self'])]);

      await runInRequestContext(() => service.getPermissionCodes('u1'));
      await runInRequestContext(() => service.getPermissionCodes('u1'));
      await service.getPermissionCodes('u1');
      await service.getPermissionCodes('u1');

      expect(accessProfileLookup(service)).toHaveBeenCalledTimes(4);
    });

    it('retries after a failed lookup within the same request', async () => {
      const service = serviceWithGrants([makeGrant(['kpi.view_self'])]);
      accessProfileLookup(service).mockRejectedValueOnce(
        new Error('connection reset'),
      );

      await runInRequestContext(async () => {
        await expect(service.getPermissionCodes('u1')).rejects.toThrow(
          'connection reset',
        );
        await expect(
          service.hasPermission('u1', 'kpi.view_self'),
        ).resolves.toBe(true);
      });

      expect(accessProfileLookup(service)).toHaveBeenCalledTimes(2);
    });
  });
});

/* ==========================================================================
 * PeriodScopeService — scope nhúng thẳng vào truy vấn danh sách của kỳ
 * ========================================================================== */

describe('PeriodScopeService inline scope filters', () => {
  const periodScope = new PeriodScopeService({} as never);
  const NO_MATCH = { id: { in: [] } };

  it('matches snapshots through the period team snapshot for TEAM scope', () => {
    expect(
      periodScope.snapshotWhere({ type: 'TEAM', teamIds: [1, 2] }, null),
    ).toEqual({ teamSnapshots: { some: { teamId: { in: [1, 2] } } } });
    expect(
      periodScope.employeeWhere({ type: 'TEAM', teamIds: [1, 2] }, 7, null),
    ).toEqual({
      periodTeamSnapshots: {
        some: { payrollPeriodId: 7, teamId: { in: [1, 2] } },
      },
    });
  });

  it('limits SELF scope to the linked employee and ALL scope to nothing', () => {
    expect(periodScope.snapshotWhere({ type: 'SELF' }, 5)).toEqual({
      employeeId: 5,
    });
    expect(periodScope.employeeWhere({ type: 'SELF' }, 7, 5)).toEqual({
      id: 5,
    });
    expect(periodScope.snapshotWhere({ type: 'ALL' }, null)).toEqual({});
    expect(periodScope.employeeWhere({ type: 'ALL' }, 7, null)).toEqual({});
  });

  it('matches no rows without a usable scope', () => {
    const unusable: ResolvedScope[] = [
      { type: 'NONE' },
      { type: 'SELF' },
      { type: 'TEAM', teamIds: [] },
    ];
    for (const scope of unusable) {
      expect(periodScope.snapshotWhere(scope, null)).toEqual(NO_MATCH);
      expect(periodScope.employeeWhere(scope, 7, null)).toEqual(NO_MATCH);
    }
  });
});

/* ==========================================================================
 * RolesService — bất biến bảo mật của system role
 * ========================================================================== */

function makeRolesPrismaMock() {
  const mock = {
    role: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    permission: { findMany: jest.fn() },
    rolePermission: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation(
    (callback: (tx: typeof mock) => unknown) => callback(mock),
  );
  return mock;
}

describe('RolesService security invariants', () => {
  it('allows revenue.write on roles other than ACCOUNTANT', async () => {
    const prisma = makeRolesPrismaMock();
    prisma.role.findUnique.mockResolvedValue({
      id: 5,
      code: 'LEADER',
      isSystemRole: true,
    });
    prisma.permission.findMany.mockResolvedValue([
      { id: 1, code: 'revenue.write' },
    ]);
    const service = new RolesService(prisma as never);

    await service.setPermissions(5, { permissionCodes: ['revenue.write'] });

    expect(prisma.rolePermission.createMany).toHaveBeenCalledWith({
      data: [{ roleId: 5, permissionId: 1 }],
    });
  });

  it('does not allow ADMIN to lose revenue.write', async () => {
    const prisma = makeRolesPrismaMock();
    prisma.role.findUnique.mockResolvedValue({
      id: 1,
      code: 'ADMIN',
      isSystemRole: true,
    });
    prisma.permission.findMany
      .mockResolvedValueOnce([{ id: 1, code: 'role.manage' }])
      .mockResolvedValueOnce([
        { code: 'role.manage' },
        { code: 'revenue.write' },
      ]);
    const service = new RolesService(prisma as never);

    await expect(
      service.setPermissions(1, { permissionCodes: ['role.manage'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled();
  });

  it('does not allow ACCOUNTANT to lose revenue.write', async () => {
    const prisma = makeRolesPrismaMock();
    prisma.role.findUnique.mockResolvedValue({
      id: 2,
      code: 'ACCOUNTANT',
      isSystemRole: true,
    });
    prisma.permission.findMany.mockResolvedValue([
      { id: 2, code: 'revenue.view_all' },
    ]);
    const service = new RolesService(prisma as never);

    await expect(
      service.setPermissions(2, { permissionCodes: ['revenue.view_all'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('does not allow ADMIN to lose a required management permission', async () => {
    const prisma = makeRolesPrismaMock();
    prisma.role.findUnique.mockResolvedValue({
      id: 1,
      code: 'ADMIN',
      isSystemRole: true,
    });
    prisma.permission.findMany
      .mockResolvedValueOnce([{ id: 1, code: 'role.manage' }])
      .mockResolvedValueOnce([
        { code: 'role.manage' },
        { code: 'user.manage' },
      ]);
    const service = new RolesService(prisma as never);

    await expect(
      service.setPermissions(1, { permissionCodes: ['role.manage'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('does not allow MANAGER_APPROVER to lose an Admin-equivalent permission', async () => {
    const prisma = makeRolesPrismaMock();
    prisma.role.findUnique.mockResolvedValue({
      id: 4,
      code: 'MANAGER_APPROVER',
      isSystemRole: true,
    });
    prisma.permission.findMany
      .mockResolvedValueOnce([{ id: 1, code: 'salary.final_approve' }])
      .mockResolvedValueOnce([
        { code: 'salary.final_approve' },
        { code: 'user.manage' },
      ]);
    const service = new RolesService(prisma as never);

    await expect(
      service.setPermissions(4, {
        permissionCodes: ['salary.final_approve'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('does not allow changing system-role metadata', async () => {
    const prisma = makeRolesPrismaMock();
    prisma.role.findUnique.mockResolvedValue({
      id: 1,
      code: 'ADMIN',
      name: 'Admin',
      description: null,
      isSystemRole: true,
    });
    const service = new RolesService(prisma as never);

    await expect(service.update(1, { name: 'Other' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.role.update).not.toHaveBeenCalled();
  });
});

/* ==========================================================================
 * UsersService — gắn tài khoản với nhân sự, gán role, chặn mất admin cuối
 * ========================================================================== */

interface PrismaMock {
  user: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  employee: { findUnique: jest.Mock; count: jest.Mock };
  role: { findMany: jest.Mock };
  team: { count: jest.Mock };
  userRole: { deleteMany: jest.Mock; createMany: jest.Mock };
  $transaction: jest.Mock;
}

function makeUserRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u1',
    employeeId: null,
    employee: null,
    email: 'a@b.com',
    fullName: 'A',
    status: 'ACTIVE',
    lastLoginAt: null,
    userRoles: [],
    ...overrides,
  };
}

function makeUsersPrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null), // không trùng email/employee mặc định
      findUnique: jest.fn().mockResolvedValue(makeUserRow()),
      findUniqueOrThrow: jest.fn().mockResolvedValue(makeUserRow()),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue(makeUserRow()),
      update: jest.fn().mockResolvedValue(makeUserRow()),
    },
    employee: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'e1',
        employeeCode: 'NV-01',
        fullName: 'Nhân sự E1',
        employeeGroups: [],
      }),
      count: jest.fn().mockResolvedValue(1),
    },
    role: { findMany: jest.fn().mockResolvedValue([]) },
    team: { count: jest.fn().mockResolvedValue(0) },
    userRole: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
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

/** Đọc `data` của lần gọi `userRole.createMany` gần nhất. */
function createManyRolesArgOf(mock: jest.Mock): Array<{
  userId: string;
  roleId: string;
  scopeType: string;
  scopeTeamId: string | null;
}> {
  const call = mock.mock.calls[0] as [{ data: unknown }] | undefined;
  if (!call) return [];
  const { data } = call[0];
  return (Array.isArray(data) ? data : [data]) as ReturnType<
    typeof createManyRolesArgOf
  >;
}

/** Đọc `data.employeeId` từ lần gọi `create`/`update` gần nhất, có kiểu tường minh (tránh unsafe any). */
function employeeIdArgOf(mock: jest.Mock): string | null | undefined {
  const call = mock.mock.calls[0] as [{ data: { employeeId?: string | null } }];
  return call[0].data.employeeId;
}

function userDataArgOf(mock: jest.Mock): { fullName?: string } {
  const calls = mock.mock.calls as unknown[][];
  return (calls[0]?.[0] as { data: { fullName?: string } }).data;
}

describe('UsersService — gắn tài khoản với nhân sự', () => {
  describe('create', () => {
    it('creates without employeeId when not provided (tài khoản thuần hệ thống)', async () => {
      const prisma = makeUsersPrismaMock();
      const service = new UsersService(prisma as never);

      await service.create({
        email: 'admin2@x.com',
        password: 'password123',
      });

      expect(prisma.employee.findUnique).not.toHaveBeenCalled();
      expect(employeeIdArgOf(prisma.user.create)).toBeUndefined();
      expect(userDataArgOf(prisma.user.create).fullName).toBe('Admin2');
    });

    it('rejects linking a non-existent employee', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.employee.findUnique.mockResolvedValue(null);
      const service = new UsersService(prisma as never);

      await expect(
        service.create({
          email: 'x@y.com',
          password: 'password123',
          employeeId: 'e-missing',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects linking an employee already linked to another account', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.user.findFirst.mockResolvedValue(makeUserRow({ id: 'u-other' }));
      const service = new UsersService(prisma as never);

      await expect(
        service.create({
          email: 'x@y.com',
          password: 'password123',
          employeeId: 'e1',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('links the employee when it exists and is unlinked', async () => {
      const prisma = makeUsersPrismaMock();
      const service = new UsersService(prisma as never);

      await service.create({
        email: 'x@y.com',
        password: 'password123',
        employeeId: 'e1',
      });

      expect(employeeIdArgOf(prisma.user.create)).toBe('e1');
    });

    it('auto-assigns default roles from employeeGroups (SELF scope) when roles are not given', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 'e1',
        employeeCode: 'NV-01',
        fullName: 'Nhân sự E1',
        employeeGroups: [
          { employeeGroup: { defaultRoleId: 'role-editor' } },
          { employeeGroup: { defaultRoleId: 'role-creator' } },
        ],
      });
      const service = new UsersService(prisma as never);

      await service.create({
        email: 'x@y.com',
        password: 'password123',
        employeeId: 'e1',
      });

      expect(createManyRolesArgOf(prisma.userRole.createMany)).toEqual([
        {
          userId: 'u1',
          roleId: 'role-editor',
          scopeType: 'SELF',
          scopeTeamId: null,
        },
        {
          userId: 'u1',
          roleId: 'role-creator',
          scopeType: 'SELF',
          scopeTeamId: null,
        },
      ]);
    });

    it('creates the account with no roles when the linked employee has no employeeGroups', async () => {
      const prisma = makeUsersPrismaMock();
      const service = new UsersService(prisma as never);

      await service.create({
        email: 'x@y.com',
        password: 'password123',
        employeeId: 'e1', // mock mặc định employeeGroups: []
      });

      expect(prisma.userRole.createMany).not.toHaveBeenCalled();
    });

    it('uses the explicit roles payload as-is (skips group-derived default)', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 'e1',
        employeeCode: 'NV-01',
        fullName: 'Nhân sự E1',
        employeeGroups: [{ employeeGroup: { defaultRoleId: 'role-editor' } }],
      });
      prisma.role.findMany.mockResolvedValue([{ id: 'role-hr', code: 'HR' }]);
      const service = new UsersService(prisma as never);

      await service.create({
        email: 'x@y.com',
        password: 'password123',
        employeeId: 'e1',
        roles: [{ roleId: 'role-hr', scopeType: 'ALL' }],
      });

      expect(createManyRolesArgOf(prisma.userRole.createMany)).toEqual([
        {
          userId: 'u1',
          roleId: 'role-hr',
          scopeType: 'ALL',
          scopeTeamId: null,
        },
      ]);
    });

    it('rejects an explicit TEAM role assignment missing scopeTeamId', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.role.findMany.mockResolvedValue([
        { id: 'role-lead', code: 'LEADER' },
      ]);
      const service = new UsersService(prisma as never);

      await expect(
        service.create({
          email: 'x@y.com',
          password: 'password123',
          roles: [{ roleId: 'role-lead', scopeType: 'TEAM' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates with no roles when roles is an explicit empty array', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.employee.findUnique.mockResolvedValue({
        id: 'e1',
        employeeCode: 'NV-01',
        fullName: 'Nhân sự E1',
        employeeGroups: [{ employeeGroup: { defaultRoleId: 'role-editor' } }],
      });
      const service = new UsersService(prisma as never);

      await service.create({
        email: 'x@y.com',
        password: 'password123',
        employeeId: 'e1',
        roles: [],
      });

      expect(prisma.userRole.createMany).not.toHaveBeenCalled();
    });

    it('rejects duplicate role assignments before writing user roles', async () => {
      const prisma = makeUsersPrismaMock();
      const service = new UsersService(prisma as never);

      await expect(
        service.create({
          email: 'x@y.com',
          password: 'password123',
          roles: [
            { roleId: 1, scopeType: 'SELF' },
            { roleId: 1, scopeType: 'SELF' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('rejects a TEAM role assignment whose team does not exist', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.role.findMany.mockResolvedValue([{ id: 1 }]);
      prisma.team.count.mockResolvedValue(0);
      const service = new UsersService(prisma as never);

      await expect(
        service.create({
          email: 'x@y.com',
          password: 'password123',
          roles: [{ roleId: 1, scopeType: 'TEAM', scopeTeamId: 99 }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('rejects a system role with an incompatible data scope', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.role.findMany.mockResolvedValue([{ id: 1, code: 'ADMIN' }]);
      const service = new UsersService(prisma as never);

      await expect(
        service.create({
          email: 'admin2@y.com',
          password: 'password123',
          roles: [{ roleId: 1, scopeType: 'SELF' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects disabling the final active administrator', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.user.findUnique.mockResolvedValue(
        makeUserRow({
          status: 'ACTIVE',
          userRoles: [{ roleId: 1, role: { code: 'ADMIN' } }],
        }),
      );
      prisma.user.count.mockResolvedValue(0);
      const service = new UsersService(prisma as never);

      await expect(
        service.update('u1', { status: 'DISABLED' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('leaves the link untouched when employeeId is not sent (undefined)', async () => {
      const prisma = makeUsersPrismaMock();
      const service = new UsersService(prisma as never);

      await service.update('u1', { fullName: 'Đổi tên' });

      expect(prisma.employee.findUnique).not.toHaveBeenCalled();
      expect(employeeIdArgOf(prisma.user.update)).toBeUndefined();
    });

    it('unlinks when employeeId is explicitly null', async () => {
      const prisma = makeUsersPrismaMock();
      const service = new UsersService(prisma as never);

      await service.update('u1', { employeeId: null });

      expect(prisma.employee.findUnique).not.toHaveBeenCalled();
      expect(employeeIdArgOf(prisma.user.update)).toBeNull();
    });

    it('rejects linking an employee already linked to a different account', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.user.findFirst.mockResolvedValue(makeUserRow({ id: 'u-other' }));
      const service = new UsersService(prisma as never);

      await expect(
        service.update('u1', { employeeId: 'e1' }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });

    it('allows re-saving the same employeeId already linked to this same account (excludes self)', async () => {
      const prisma = makeUsersPrismaMock();
      // findFirst cho conflict-check employeeId trả về null vì `id:{not:'u1'}` đã loại trừ chính nó.
      prisma.user.findFirst.mockResolvedValue(null);
      const service = new UsersService(prisma as never);

      await expect(
        service.update('u1', { employeeId: 'e1' }),
      ).resolves.toBeDefined();
      expect(employeeIdArgOf(prisma.user.update)).toBe('e1');
    });

    it('links a new employee successfully', async () => {
      const prisma = makeUsersPrismaMock();
      const service = new UsersService(prisma as never);

      await service.update('u1', { employeeId: 'e1' });

      expect(prisma.employee.findUnique).toHaveBeenCalledWith({
        where: { id: 'e1' },
        include: {
          employeeGroups: {
            select: { employeeGroup: { select: { defaultRoleId: true } } },
          },
        },
      });
      expect(employeeIdArgOf(prisma.user.update)).toBe('e1');
    });
  });

  describe('setRoles', () => {
    it('rejects removing ADMIN from the final active administrator', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.user.findUnique.mockResolvedValue(
        makeUserRow({
          status: 'ACTIVE',
          userRoles: [{ roleId: 1, role: { code: 'ADMIN' } }],
        }),
      );
      prisma.user.count.mockResolvedValue(0);
      const service = new UsersService(prisma as never);

      await expect(service.setRoles('u1', { roles: [] })).rejects.toMatchObject(
        { code: 'CONFLICT' },
      );
      expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('scope quản lý tài khoản', () => {
    function makeAuthorizationScope(scope: {
      type: 'ALL' | 'SELF' | 'NONE' | 'TEAM';
      teamIds?: number[];
    }) {
      return {
        resolvePermissionScope: jest.fn().mockResolvedValue(scope),
        getEmployeeId: jest.fn().mockResolvedValue(10),
      };
    }

    it('chỉ liệt kê tài khoản gắn với nhân sự thuộc team của Leader', async () => {
      const prisma = makeUsersPrismaMock();
      const authorization = makeAuthorizationScope({
        type: 'TEAM',
        teamIds: [7],
      });
      const service = new UsersService(prisma as never, authorization as never);

      await service.list({ page: 1, pageSize: 20 }, 'leader-user');

      const expectedWhere = {
        employee: {
          is: {
            OR: [
              { teamId: { in: [7] } },
              {
                teamMemberships: {
                  some: { teamId: { in: [7] }, isActive: true },
                },
              },
            ],
          },
        },
      };
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere }),
      );
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: expectedWhere,
      });
    });

    it('chặn Leader sửa tài khoản ngoài team ngay cả khi gọi API trực tiếp', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.user.count.mockResolvedValue(0);
      const authorization = makeAuthorizationScope({
        type: 'TEAM',
        teamIds: [7],
      });
      const service = new UsersService(prisma as never, authorization as never);

      await expect(
        service.update(
          'outside-user',
          { fullName: 'Không được sửa' },
          'leader-user',
        ),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('chặn Leader gán vai trò ALL cho tài khoản trong team', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.role.findMany.mockResolvedValue([{ id: 2, code: 'HR' }]);
      const authorization = makeAuthorizationScope({
        type: 'TEAM',
        teamIds: [7],
      });
      const service = new UsersService(prisma as never, authorization as never);

      await expect(
        service.setRoles(
          'team-user',
          { roles: [{ roleId: 2, scopeType: 'ALL' }] },
          'leader-user',
        ),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
      expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
    });

    it('chặn Leader tạo tài khoản cho nhân sự ngoài team', async () => {
      const prisma = makeUsersPrismaMock();
      prisma.employee.count.mockResolvedValue(0);
      const authorization = makeAuthorizationScope({
        type: 'TEAM',
        teamIds: [7],
      });
      const service = new UsersService(prisma as never, authorization as never);

      await expect(
        service.create(
          {
            email: 'outside@x.com',
            password: 'password123',
            employeeId: 99,
          },
          'leader-user',
        ),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });
});
