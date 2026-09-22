import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

interface ErrorBody {
  code: string;
}

interface EmployeeBody {
  id: number;
  employeeCode: string;
}

interface TeamBody {
  id: number;
  code: string;
}

interface DepartmentBody {
  id: number;
  code: string;
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

describe('Organization (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

  async function createDepartment(
    cookies: Record<string, string>,
    name: string,
  ): Promise<DepartmentBody> {
    const response = await withAuth(
      request(app.getHttpServer()).post('/api/departments'),
      cookies,
    )
      .send({ name })
      .expect(201);
    return response.body as DepartmentBody;
  }

  it('lets Admin manage departments and teams, but blocks Editor', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const department = await createDepartment(
      adminCookies,
      `E2E Department ${Date.now()}`,
    );
    const teamRes = await withAuth(
      request(app.getHttpServer()).post('/api/teams'),
      adminCookies,
    )
      .send({ name: 'E2E Test Team', departmentId: department.id })
      .expect(201);
    expect((teamRes.body as TeamBody).code).toContain('TEAM-');

    const conflict = await withAuth(
      request(app.getHttpServer()).delete(`/api/departments/${department.id}`),
      adminCookies,
    ).expect(409);
    expect((conflict.body as ErrorBody).code).toBe('CONFLICT');

    const editorCookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const forbidden = await withAuth(
      request(app.getHttpServer()).post('/api/departments'),
      editorCookies,
    )
      .send({ name: 'Should fail' })
      .expect(403);
    expect((forbidden.body as ErrorBody).code).toBe('FORBIDDEN');
  });

  it('creates an auto-coded employee and rejects self as leader', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const department = await createDepartment(
      adminCookies,
      `Employee Test Department ${Date.now()}`,
    );
    const teamRes = await withAuth(
      request(app.getHttpServer()).post('/api/teams'),
      adminCookies,
    )
      .send({ name: 'Employee Test Team', departmentId: department.id })
      .expect(201);
    const teamId = (teamRes.body as TeamBody).id;

    const createRes = await withAuth(
      request(app.getHttpServer()).post('/api/employees'),
      adminCookies,
    )
      .send({
        fullName: 'Nhân Viên Test',
        jobTitle: 'QA',
        teamId,
      })
      .expect(201);
    const employee = createRes.body as EmployeeBody;
    expect(employee.employeeCode).toMatch(/^NV-\d{6}$/);
    const employeeId = employee.id;

    const selfLeaderRes = await withAuth(
      request(app.getHttpServer()).patch(`/api/employees/${employeeId}`),
      adminCookies,
    )
      .send({ leaderEmployeeId: employeeId })
      .expect(400);
    expect((selfLeaderRes.body as ErrorBody).code).toBe('VALIDATION_ERROR');
  });

  it('scopes GET /employees to the Leader’s own team (TEAM scope)', async () => {
    const leaderCookies = await loginAs('leader@vcbsalary.vn', 'Admin@123');
    const res = await withAuth(
      request(app.getHttpServer()).get('/api/employees'),
      leaderCookies,
    ).expect(200);

    const body = res.body as PaginatedBody<EmployeeBody>;
    const codes = body.data.map((e) => e.employeeCode);
    expect(codes).toEqual(
      expect.arrayContaining(['NV-LEAD-01', 'NV-ED-01', 'NV-CC-01']),
    );
  });

  it('scopes GET /employees to only the linked employee for Editor (SELF scope)', async () => {
    const editorCookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const res = await withAuth(
      request(app.getHttpServer()).get('/api/employees'),
      editorCookies,
    ).expect(200);

    const body = res.body as PaginatedBody<EmployeeBody>;
    expect(body.data.map((e) => e.employeeCode)).toEqual(['NV-ED-01']);
  });

  it('blocks Editor from viewing another employee’s detail (OUT_OF_SCOPE)', async () => {
    const editorCookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const listRes = await withAuth(
      request(app.getHttpServer()).get('/api/employees'),
      editorCookies,
    ).expect(200);
    const ownId = (listRes.body as PaginatedBody<EmployeeBody>).data[0].id;

    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const allRes = await withAuth(
      request(app.getHttpServer()).get('/api/employees?pageSize=100'),
      adminCookies,
    ).expect(200);
    const someoneElse = (allRes.body as PaginatedBody<EmployeeBody>).data.find(
      (e) => e.id !== ownId,
    );
    expect(someoneElse).toBeDefined();

    const forbidden = await withAuth(
      request(app.getHttpServer()).get(`/api/employees/${someoneElse!.id}`),
      editorCookies,
    ).expect(403);
    expect((forbidden.body as ErrorBody).code).toBe('OUT_OF_SCOPE');
  });
});
