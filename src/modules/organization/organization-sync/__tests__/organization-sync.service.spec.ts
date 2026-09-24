import { OrganizationSyncService } from '../organization-sync.service';
import type { AutomationGenVideoTeamDetail } from '../../../../common/clients/automation-gen-video.client';

function makePrismaMock() {
  return {
    department: {
      upsert: jest.fn().mockResolvedValue({ id: 'department-marketing' }),
    },
    team: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    employeeGroup: {
      findMany: jest.fn().mockResolvedValue([
        { id: 1, code: 'EDITOR' },
        { id: 2, code: 'CONTENT_CREATOR' },
      ]),
    },
    employee: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    externalEmployeeIdentity: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    employeeTeamMembership: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 1, isPrimary: true, isActive: true }),
      update: jest.fn().mockResolvedValue({ isPrimary: true }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    orgSyncRun: {
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
    },
    orgSyncRunItem: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
}

function makeClientMock() {
  return { fetchTeams: jest.fn(), fetchTeamForPayrollSync: jest.fn() };
}

interface RunUpdateData {
  status: string;
  successfulRecords?: number;
  failedRecords?: number;
}
interface ItemCreateData {
  externalRecordKey: string;
  resultStatus: string;
  employeeId?: number;
  errorMessage?: string;
}

function lastRunUpdateData(mock: jest.Mock): RunUpdateData {
  const calls = mock.mock.calls as [{ data: RunUpdateData }][];
  return calls[calls.length - 1][0].data;
}

function findItemCreateData(
  mock: jest.Mock,
  externalRecordKey: string,
): ItemCreateData | undefined {
  const calls = mock.mock.calls as [{ data: ItemCreateData }][];
  return calls.find(
    ([arg]) => arg.data.externalRecordKey === externalRecordKey,
  )?.[0].data;
}

function lastTeamWriteDepartmentId(mock: jest.Mock): string | undefined {
  const calls = mock.mock.calls as [{ data: { departmentId?: string } }][];
  return calls[calls.length - 1]?.[0].data.departmentId;
}

const LEADER_EXTERNAL_ID = 'ext-leader';
const REPORT_EXTERNAL_ID = 'ext-report';

function baseTeamPayload(): AutomationGenVideoTeamDetail {
  return {
    id: 'ext-team-1',
    name: 'Team Editor Tiktok',
    leader_id: LEADER_EXTERNAL_ID,
    is_active: true,
    updated_at: new Date().toISOString(),
    members: [
      {
        user_id: LEADER_EXTERNAL_ID,
        joined_at: new Date().toISOString(),
        is_content_creator: false,
        full_name: 'Leader Nguyen',
        email: 'leader@agv.test',
        employee_id: 'NV-LEAD-01',
        employee_position: null,
        manager_id: null,
        is_active: true,
        deleted_at: null,
        employee_status: null,
      },
      {
        user_id: REPORT_EXTERNAL_ID,
        joined_at: new Date().toISOString(),
        is_content_creator: false,
        full_name: 'Editor Tran',
        email: 'editor@agv.test',
        employee_id: 'NV-ED-01',
        employee_position: null,
        manager_id: LEADER_EXTERNAL_ID,
        is_active: true,
        deleted_at: null,
        employee_status: null,
      },
    ],
  };
}

describe('OrganizationSyncService', () => {
  describe('syncAllTeams', () => {
    it('syncs every unique source team and keeps going when one team fails', async () => {
      const prisma = makePrismaMock();
      const client = makeClientMock();
      client.fetchTeams.mockResolvedValue([
        { id: 'team-1' },
        { id: 'team-2' },
        { id: 'team-1' },
      ]);
      const service = new OrganizationSyncService(
        prisma as never,
        client as never,
      );
      const syncTeamSpy = jest
        .spyOn(service, 'syncTeam')
        .mockResolvedValueOnce({ status: 'SUCCESS' } as never)
        .mockRejectedValueOnce(new Error('source unavailable'));

      await expect(service.syncAllTeams('user-admin')).resolves.toMatchObject({
        totalTeams: 2,
        successfulTeams: 1,
        partialTeams: 0,
        failedTeams: 1,
        failedTeamIds: ['team-2'],
      });
      expect(syncTeamSpy).toHaveBeenCalledTimes(2);
      expect(syncTeamSpy).toHaveBeenCalledWith('team-1', 'user-admin');
      expect(syncTeamSpy).toHaveBeenCalledWith('team-2', 'user-admin');
    });
  });

  describe('syncTeam — first run (create path)', () => {
    it('creates the team and employees, and resolves leader/manager in pass 2', async () => {
      const prisma = makePrismaMock();
      const client = makeClientMock();
      client.fetchTeamForPayrollSync.mockResolvedValue(baseTeamPayload());

      prisma.orgSyncRun.create.mockResolvedValue({ id: 'run-1' });
      prisma.orgSyncRun.update.mockResolvedValue({ id: 'run-1' });
      prisma.team.findUnique.mockResolvedValue(null); // no existing team by externalId, code available
      prisma.team.create.mockResolvedValue({ id: 'team-1' });
      prisma.employee.findUnique.mockResolvedValue(null); // not synced yet, code available
      prisma.employee.create.mockImplementation(
        ({ data }: { data: { employeeCode: string } }) =>
          Promise.resolve({ id: `emp-${data.employeeCode}` }),
      );

      const service = new OrganizationSyncService(
        prisma as never,
        client as never,
      );

      await service.syncTeam('ext-team-1', 'user-admin');

      expect(prisma.team.create).toHaveBeenCalledTimes(1);
      expect(lastTeamWriteDepartmentId(prisma.team.create)).toBe(
        'department-marketing',
      );
      expect(prisma.employee.create).toHaveBeenCalledTimes(2);

      const updateCalls = prisma.employee.update.mock.calls as [
        { where: { id: string }; data: Record<string, unknown> },
      ][];

      const leaderUpdate = updateCalls.find(
        ([arg]) =>
          arg.where.id === 'emp-NV-AGV-EXTLEADER' &&
          'managerEmployeeId' in arg.data,
      );
      const reportUpdate = updateCalls.find(
        ([arg]) =>
          arg.where.id === 'emp-NV-AGV-EXTREPORT' &&
          'managerEmployeeId' in arg.data,
      );

      // Leader không thể là leader/manager của chính mình — chỉ managerEmployeeId=null được set.
      expect(leaderUpdate?.[0].data).toEqual({ managerEmployeeId: null });
      // Report có leader/manager đều trỏ về leader đã tạo trong CÙNG run (qua cache pass 1).
      expect(reportUpdate?.[0].data).toEqual({
        leaderEmployeeId: 'emp-NV-AGV-EXTLEADER',
        managerEmployeeId: 'emp-NV-AGV-EXTLEADER',
      });

      const finalRunUpdate = lastRunUpdateData(prisma.orgSyncRun.update);
      expect(finalRunUpdate.status).toBe('SUCCESS');
      expect(finalRunUpdate.successfulRecords).toBe(2);
    });
  });

  describe('syncTeam — re-run (idempotent update path)', () => {
    it('updates the existing team/employees instead of creating duplicates', async () => {
      const prisma = makePrismaMock();
      const client = makeClientMock();
      client.fetchTeamForPayrollSync.mockResolvedValue(baseTeamPayload());

      prisma.orgSyncRun.create.mockResolvedValue({ id: 'run-2' });
      prisma.orgSyncRun.update.mockResolvedValue({ id: 'run-2' });
      prisma.team.findUnique.mockResolvedValue({ id: 'team-1' }); // already synced
      prisma.team.update.mockResolvedValue({ id: 'team-1' });
      prisma.externalEmployeeIdentity.findMany.mockResolvedValue([
        { externalUserId: LEADER_EXTERNAL_ID, employeeId: 'emp-lead' },
        { externalUserId: REPORT_EXTERNAL_ID, employeeId: 'emp-report' },
      ]);
      prisma.employee.findUnique.mockResolvedValue(null);
      prisma.employee.update.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve({ id: where.id }),
      );

      const service = new OrganizationSyncService(
        prisma as never,
        client as never,
      );

      await service.syncTeam('ext-team-1', 'user-admin');

      expect(prisma.team.create).not.toHaveBeenCalled();
      expect(prisma.employee.create).not.toHaveBeenCalled();
      expect(prisma.team.update).toHaveBeenCalledTimes(1);
      expect(lastTeamWriteDepartmentId(prisma.team.update)).toBe(
        'department-marketing',
      );
      // 2 base-field + 2 đồng bộ primary team legacy + 2 hierarchy.
      expect(prisma.employee.update).toHaveBeenCalledTimes(6);
    });
  });

  describe('syncTeam — data quality edge cases', () => {
    it('creates a member with a stable internal code when employee_id and fallback are missing', async () => {
      const prisma = makePrismaMock();
      const client = makeClientMock();
      const payload = baseTeamPayload();
      payload.members[1].employee_id = null;
      client.fetchTeamForPayrollSync.mockResolvedValue(payload);

      prisma.orgSyncRun.create.mockResolvedValue({ id: 'run-3' });
      prisma.orgSyncRun.update.mockResolvedValue({ id: 'run-3' });
      prisma.team.findUnique.mockResolvedValue(null);
      prisma.team.create.mockResolvedValue({ id: 'team-1' });
      prisma.employee.findUnique.mockResolvedValue(null);
      prisma.employee.create.mockImplementation(
        ({ data }: { data: { employeeCode: string } }) =>
          Promise.resolve({ id: `emp-${data.employeeCode}` }),
      );

      const service = new OrganizationSyncService(
        prisma as never,
        client as never,
      );

      await service.syncTeam('ext-team-1', 'user-admin');

      expect(prisma.employee.create).toHaveBeenCalledTimes(2);
      const employeeCreateCalls = prisma.employee.create.mock
        .calls as unknown as [
        { data: { employeeCode: string; externalId: string } },
      ][];
      expect(
        employeeCreateCalls.some(
          ([input]) =>
            input.data.employeeCode === 'NV-AGV-EXTREPORT' &&
            input.data.externalId === REPORT_EXTERNAL_ID,
        ),
      ).toBe(true);
      const createdItem = findItemCreateData(
        prisma.orgSyncRunItem.create,
        REPORT_EXTERNAL_ID,
      );
      expect(createdItem?.resultStatus).toBe('SUCCESS');

      const finalRunUpdate = lastRunUpdateData(prisma.orgSyncRun.update);
      expect(finalRunUpdate).toMatchObject({
        status: 'SUCCESS',
        successfulRecords: 2,
        failedRecords: 0,
      });
    });

    it('links a member without employee_id to one unique employee by email', async () => {
      const prisma = makePrismaMock();
      const client = makeClientMock();
      const payload = baseTeamPayload();
      payload.members[1].employee_id = null;
      payload.members[1].full_name = 'Tên nguồn đã thay đổi';
      client.fetchTeamForPayrollSync.mockResolvedValue(payload);

      prisma.orgSyncRun.create.mockResolvedValue({ id: 'run-fallback' });
      prisma.orgSyncRun.update.mockResolvedValue({ id: 'run-fallback' });
      prisma.team.findUnique.mockResolvedValue(null);
      prisma.team.create.mockResolvedValue({ id: 'team-1' });
      prisma.employee.findMany
        .mockResolvedValueOnce([
          {
            id: 77,
            externalId: null,
            fullName: 'Tên nội bộ',
            user: { email: 'EDITOR@agv.test' },
          },
        ])
        .mockResolvedValue([]);
      prisma.employee.findUnique.mockResolvedValue(null);
      prisma.employee.create.mockResolvedValue({ id: 11 });
      prisma.employee.update.mockImplementation(
        ({ where }: { where: { id: number } }) =>
          Promise.resolve({ id: where.id }),
      );

      const service = new OrganizationSyncService(
        prisma as never,
        client as never,
      );

      await service.syncTeam('ext-team-1', 'user-admin');

      const employeeUpdateCalls = prisma.employee.update.mock
        .calls as unknown as [
        {
          where: { id: number };
          data: { externalId?: string; employeeCode?: string };
        },
      ][];
      const linkedUpdate = employeeUpdateCalls.find(
        ([input]) => input.where.id === 77 && input.data.fullName,
      );
      expect(linkedUpdate?.[0]).toMatchObject({
        where: { id: 77 },
        data: { fullName: 'Tên nguồn đã thay đổi' },
      });
      expect(linkedUpdate?.[0].data).not.toHaveProperty('employeeCode');
      const identityCalls = prisma.externalEmployeeIdentity.upsert.mock
        .calls as unknown as [
        { create: { employeeId: number; externalUserId: string } },
      ][];
      expect(
        identityCalls.some(
          ([input]) =>
            input.create.employeeId === 77 &&
            input.create.externalUserId === REPORT_EXTERNAL_ID,
        ),
      ).toBe(true);
      expect(
        findItemCreateData(prisma.orgSyncRunItem.create, REPORT_EXTERNAL_ID),
      ).toMatchObject({ resultStatus: 'SUCCESS', employeeId: 77 });
      expect(lastRunUpdateData(prisma.orgSyncRun.update)).toMatchObject({
        status: 'SUCCESS',
        successfulRecords: 2,
        failedRecords: 0,
      });
    });

    it('does not auto-create when fallback name is ambiguous', async () => {
      const prisma = makePrismaMock();
      const client = makeClientMock();
      const payload = baseTeamPayload();
      payload.members[1].employee_id = null;
      payload.members[1].email = '';
      client.fetchTeamForPayrollSync.mockResolvedValue(payload);

      prisma.orgSyncRun.create.mockResolvedValue({ id: 'run-ambiguous' });
      prisma.orgSyncRun.update.mockResolvedValue({ id: 'run-ambiguous' });
      prisma.team.findUnique.mockResolvedValue(null);
      prisma.team.create.mockResolvedValue({ id: 'team-1' });
      prisma.employee.findMany
        .mockResolvedValueOnce([
          { id: 77, externalId: null, fullName: 'Editor Tran', user: null },
          { id: 78, externalId: null, fullName: 'Editor Tran', user: null },
        ])
        .mockResolvedValue([]);
      prisma.employee.findUnique.mockResolvedValue(null);
      prisma.employee.create.mockResolvedValue({ id: 11 });

      const service = new OrganizationSyncService(
        prisma as never,
        client as never,
      );

      await service.syncTeam('ext-team-1', 'user-admin');

      expect(prisma.employee.create).toHaveBeenCalledTimes(1);
      const ambiguousItem = findItemCreateData(
        prisma.orgSyncRunItem.create,
        REPORT_EXTERNAL_ID,
      );
      expect(ambiguousItem?.resultStatus).toBe('SKIPPED');
      expect(ambiguousItem?.errorMessage).toContain('Tên khớp nhiều');
      expect(lastRunUpdateData(prisma.orgSyncRun.update)).toMatchObject({
        status: 'PARTIAL',
        successfulRecords: 1,
        failedRecords: 1,
      });
    });

    it('records a FAILED item and keeps processing when employeeCode collides with a manual record', async () => {
      const prisma = makePrismaMock();
      const client = makeClientMock();
      client.fetchTeamForPayrollSync.mockResolvedValue(baseTeamPayload());

      prisma.orgSyncRun.create.mockResolvedValue({ id: 'run-4' });
      prisma.orgSyncRun.update.mockResolvedValue({ id: 'run-4' });
      prisma.team.findUnique.mockResolvedValue(null);
      prisma.team.create.mockResolvedValue({ id: 'team-1' });

      prisma.employee.findUnique.mockImplementation(
        ({
          where,
        }: {
          where: { externalId?: string; employeeCode?: string };
        }) => {
          if (where.externalId) return Promise.resolve(null); // chưa từng sync
          if (where.employeeCode === 'NV-AGV-EXTLEADER') {
            return Promise.resolve({ id: 'manual-emp' }); // đã bị nhập tay trùng mã
          }
          return Promise.resolve(null);
        },
      );
      prisma.employee.create.mockImplementation(
        ({ data }: { data: { employeeCode: string } }) =>
          Promise.resolve({ id: `emp-${data.employeeCode}` }),
      );

      const service = new OrganizationSyncService(
        prisma as never,
        client as never,
      );

      await service.syncTeam('ext-team-1', 'user-admin');

      // Leader có mã nội bộ ổn định bị trùng -> không tạo; report vẫn tạo bình thường.
      expect(prisma.employee.create).toHaveBeenCalledTimes(1);
      const failedItem = findItemCreateData(
        prisma.orgSyncRunItem.create,
        LEADER_EXTERNAL_ID,
      );
      expect(failedItem?.resultStatus).toBe('FAILED');
      expect(failedItem?.errorMessage).toContain('NV-AGV-EXTLEADER');

      const finalRunUpdate = lastRunUpdateData(prisma.orgSyncRun.update);
      expect(finalRunUpdate.status).toBe('PARTIAL');
    });
  });

  describe('getRun', () => {
    it('throws NOT_FOUND when the run does not exist', async () => {
      const prisma = makePrismaMock();
      prisma.orgSyncRun.findUnique.mockResolvedValue(null);
      const service = new OrganizationSyncService(
        prisma as never,
        makeClientMock() as never,
      );

      await expect(service.getRun('missing')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
