import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AutomationGenVideoClient } from '../src/common/clients/automation-gen-video.client';

interface ErrorBody {
  code: string;
}

interface TeamBody {
  id: string;
  code: string;
  name: string;
  sourceSystem: string | null;
}

interface OrgSyncRunBody {
  id: string;
  status: string;
  totalRecords: number;
  successfulRecords: number;
  failedRecords: number;
  items: { externalRecordKey: string; resultStatus: string }[];
}

interface PaginatedBody<T> {
  data: T[];
}

function parseCookies(
  setCookieHeader: string[] | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const raw of setCookieHeader ?? []) {
    const [pair] = raw.split(';');
    const separatorIndex = pair.indexOf('=');
    cookies[pair.slice(0, separatorIndex)] = pair.slice(separatorIndex + 1);
  }
  return cookies;
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function withAuth<T extends request.Test>(
  req: T,
  cookies: Record<string, string>,
): T {
  return req
    .set('Cookie', cookieHeader(cookies))
    .set('x-csrf-token', cookies.vcbsalary_csrf);
}

describe('Organization Sync (e2e)', () => {
  let app: INestApplication<App>;
  const mockClient = {
    fetchTeams: jest.fn(),
    fetchTeamForPayrollSync: jest.fn(),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AutomationGenVideoClient)
      .useValue(mockClient)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function loginAs(email: string, password: string) {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(201);
    return parseCookies(res.headers['set-cookie'] as unknown as string[]);
  }

  function buildTeamPayload(suffix: string) {
    const leaderExternalId = randomUUID();
    const editorExternalId = randomUUID();
    const noCodeExternalId = randomUUID();
    return {
      id: randomUUID(),
      name: `E2E Editor Team ${suffix}`,
      leader_id: leaderExternalId,
      is_active: true,
      updated_at: new Date().toISOString(),
      members: [
        {
          user_id: leaderExternalId,
          joined_at: new Date().toISOString(),
          is_content_creator: false,
          full_name: 'E2E Leader',
          email: `e2e-leader-${suffix}@agv.test`,
          employee_id: `E2E-LEAD-${suffix}`,
          employee_position: null,
          manager_id: null,
          is_active: true,
          deleted_at: null,
          employee_status: null,
        },
        {
          user_id: editorExternalId,
          joined_at: new Date().toISOString(),
          is_content_creator: false,
          full_name: 'E2E Editor',
          email: `e2e-editor-${suffix}@agv.test`,
          employee_id: `E2E-ED-${suffix}`,
          employee_position: null,
          manager_id: leaderExternalId,
          is_active: true,
          deleted_at: null,
          employee_status: null,
        },
        {
          // Không có employee_id — phải bị SKIP, không tạo Employee.
          user_id: noCodeExternalId,
          joined_at: new Date().toISOString(),
          is_content_creator: false,
          full_name: 'E2E No Code',
          email: `e2e-nocode-${suffix}@agv.test`,
          employee_id: null,
          employee_position: null,
          manager_id: null,
          is_active: true,
          deleted_at: null,
          employee_status: null,
        },
      ],
    };
  }

  it('blocks Editor (no employee.manage) from triggering a sync', async () => {
    const editorCookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const externalTeamId = randomUUID();

    const res = await withAuth(
      request(app.getHttpServer()).post(
        `/api/organization-sync/teams/${externalTeamId}`,
      ),
      editorCookies,
    ).expect(403);
    expect((res.body as ErrorBody).code).toBe('FORBIDDEN');
    expect(mockClient.fetchTeamForPayrollSync).not.toHaveBeenCalled();
  });

  it('lets Admin trigger all-team sync without providing a team id', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    mockClient.fetchTeams.mockResolvedValueOnce([]);

    const res = await withAuth(
      request(app.getHttpServer()).post('/api/organization-sync/teams'),
      adminCookies,
    ).expect(201);

    expect(res.body).toMatchObject({
      totalTeams: 0,
      successfulTeams: 0,
      partialTeams: 0,
      failedTeams: 0,
    });
    expect(mockClient.fetchTeams).toHaveBeenCalledTimes(1);
  });

  it('lets Admin trigger a sync that creates the team/employees, skips records without employee_id, and is idempotent on re-run', async () => {
    const suffix = `${Date.now()}`;
    const payload = buildTeamPayload(suffix);
    mockClient.fetchTeamForPayrollSync.mockResolvedValue(payload);

    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');

    const firstRunRes = await withAuth(
      request(app.getHttpServer()).post(
        `/api/organization-sync/teams/${payload.id}`,
      ),
      adminCookies,
    ).expect(201);
    const firstRun = firstRunRes.body as OrgSyncRunBody;
    expect(firstRun.status).toBe('PARTIAL'); // 2 success + 1 skipped
    expect(firstRun.totalRecords).toBe(3);
    expect(firstRun.successfulRecords).toBe(2);

    const teamsRes = await withAuth(
      request(app.getHttpServer()).get('/api/teams'),
      adminCookies,
    ).expect(200);
    const createdTeam = (teamsRes.body as TeamBody[]).find(
      (t) => t.name === payload.name,
    );
    expect(createdTeam).toBeDefined();
    expect(createdTeam?.sourceSystem).toBe('AUTOMATION_GEN_VIDEO');

    const employeesRes = await withAuth(
      request(app.getHttpServer()).get(
        `/api/employees?search=E2E-LEAD-${suffix}&pageSize=10`,
      ),
      adminCookies,
    ).expect(200);
    const employeesBody = employeesRes.body as PaginatedBody<{
      employeeCode: string;
    }>;
    expect(employeesBody.data.map((e) => e.employeeCode)).toContain(
      `E2E-LEAD-${suffix}`,
    );

    // Chạy lại lần 2 — không được tạo trùng team (vẫn đúng 1 team tên này).
    const secondRunRes = await withAuth(
      request(app.getHttpServer()).post(
        `/api/organization-sync/teams/${payload.id}`,
      ),
      adminCookies,
    ).expect(201);
    expect((secondRunRes.body as OrgSyncRunBody).successfulRecords).toBe(2);

    const teamsAfterSecondRunRes = await withAuth(
      request(app.getHttpServer()).get('/api/teams'),
      adminCookies,
    ).expect(200);
    const matchingTeams = (teamsAfterSecondRunRes.body as TeamBody[]).filter(
      (t) => t.name === payload.name,
    );
    expect(matchingTeams).toHaveLength(1);
    expect(matchingTeams[0].id).toBe(createdTeam?.id);

    const runDetailRes = await withAuth(
      request(app.getHttpServer()).get(
        `/api/organization-sync/runs/${firstRun.id}`,
      ),
      adminCookies,
    ).expect(200);
    const runDetail = runDetailRes.body as OrgSyncRunBody;
    expect(
      runDetail.items.find(
        (i) => i.externalRecordKey === payload.members[2].user_id,
      )?.resultStatus,
    ).toBe('SKIPPED');
  });

  it('lists sync runs via GET /organization-sync/runs', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const res = await withAuth(
      request(app.getHttpServer()).get('/api/organization-sync/runs'),
      adminCookies,
    ).expect(200);
    const body = res.body as PaginatedBody<OrgSyncRunBody>;
    expect(body.data.length).toBeGreaterThan(0);
  });
});
