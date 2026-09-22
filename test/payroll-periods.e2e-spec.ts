import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

interface ErrorBody {
  code: string;
}

interface PayrollPeriodBody {
  id: number;
  code: string;
  status: string;
  startDate: string;
  endDate: string;
}

interface PaginatedBody<T> {
  data: T[];
}

interface SnapshotBody {
  employeeCodeSnapshot: string;
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

describe('Payroll Periods (e2e)', () => {
  let app: INestApplication<App>;
  let periodSequence = 0;

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

  async function createDraftPeriod(cookies: Record<string, string>) {
    const suffix = `${Date.now()}`;
    if (periodSequence === 0) {
      const list = await withAuth(
        request(app.getHttpServer()).get(
          '/api/payroll-periods?page=1&pageSize=1',
        ),
        cookies,
      ).expect(200);
      const latest = (list.body as PaginatedBody<PayrollPeriodBody>).data[0];
      periodSequence = Math.max(
        2100,
        latest ? new Date(latest.startDate).getUTCFullYear() + 1 : 2100,
      );
    }
    const year = periodSequence++;
    const res = await withAuth(
      request(app.getHttpServer()).post('/api/payroll-periods'),
      cookies,
    )
      .send({
        name: `Kỳ test ${suffix}`,
        startDate: `${year}-01-01`,
        endDate: `${year}-01-31`,
      })
      .expect(201);
    return res.body as PayrollPeriodBody;
  }

  it('lets Admin create a period, but blocks Editor from doing so', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const period = await createDraftPeriod(adminCookies);
    expect(period.status).toBe('DRAFT');

    const editorCookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const suffix = `${Date.now()}`;
    const forbidden = await withAuth(
      request(app.getHttpServer()).post('/api/payroll-periods'),
      editorCookies,
    )
      .send({
        name: `Should fail ${suffix}`,
        startDate: '2032-01-01',
        endDate: '2032-01-31',
      })
      .expect(403);
    expect((forbidden.body as ErrorBody).code).toBe('FORBIDDEN');
  });

  it('rejects an overlapping period and an invalid date range', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const period = await createDraftPeriod(adminCookies);

    const overlap = await withAuth(
      request(app.getHttpServer()).post('/api/payroll-periods'),
      adminCookies,
    )
      .send({
        name: 'Trùng khoảng ngày',
        startDate: period.startDate,
        endDate: period.endDate,
      })
      .expect(400);
    expect((overlap.body as ErrorBody).code).toBe('VALIDATION_ERROR');

    const suffix = `${Date.now()}`;
    const badRange = await withAuth(
      request(app.getHttpServer()).post('/api/payroll-periods'),
      adminCookies,
    )
      .send({
        name: `Ngày sai ${suffix}`,
        startDate: '2034-02-01',
        endDate: '2034-01-01',
      })
      .expect(400);
    expect((badRange.body as ErrorBody).code).toBe('VALIDATION_ERROR');
  });

  it('lets any authenticated user read the period list/detail without a special permission', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const period = await createDraftPeriod(adminCookies);

    const editorCookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const listRes = await withAuth(
      request(app.getHttpServer()).get('/api/payroll-periods'),
      editorCookies,
    ).expect(200);
    expect((listRes.body as PaginatedBody<PayrollPeriodBody>).data).toEqual(
      expect.any(Array),
    );

    await withAuth(
      request(app.getHttpServer()).get(`/api/payroll-periods/${period.id}`),
      editorCookies,
    ).expect(200);
  });

  it('opens a DRAFT period, snapshots active employees, and is idempotent against a second open', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const period = await createDraftPeriod(adminCookies);

    const openRes = await withAuth(
      request(app.getHttpServer()).post(
        `/api/payroll-periods/${period.id}/open`,
      ),
      adminCookies,
    ).expect(201);
    expect((openRes.body as PayrollPeriodBody).status).toBe('OPEN');

    const snapshotsRes = await withAuth(
      request(app.getHttpServer()).get(
        `/api/payroll-periods/${period.id}/employee-snapshots?pageSize=100`,
      ),
      adminCookies,
    ).expect(200);
    const codes = (snapshotsRes.body as PaginatedBody<SnapshotBody>).data.map(
      (s) => s.employeeCodeSnapshot,
    );
    expect(codes).toEqual(expect.arrayContaining(['NV-LEAD-01']));

    const secondOpen = await withAuth(
      request(app.getHttpServer()).post(
        `/api/payroll-periods/${period.id}/open`,
      ),
      adminCookies,
    ).expect(400);
    expect((secondOpen.body as ErrorBody).code).toBe('VALIDATION_ERROR');
  });

  it('rejects out-of-order transitions and edits after leaving DRAFT', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const period = await createDraftPeriod(adminCookies);

    const closeFromDraft = await withAuth(
      request(app.getHttpServer()).post(
        `/api/payroll-periods/${period.id}/close`,
      ),
      adminCookies,
    ).expect(400);
    expect((closeFromDraft.body as ErrorBody).code).toBe('VALIDATION_ERROR');

    await withAuth(
      request(app.getHttpServer()).post(
        `/api/payroll-periods/${period.id}/open`,
      ),
      adminCookies,
    ).expect(201);

    const editAfterOpen = await withAuth(
      request(app.getHttpServer()).patch(`/api/payroll-periods/${period.id}`),
      adminCookies,
    )
      .send({ name: 'Đổi tên sau khi mở' })
      .expect(400);
    expect((editAfterOpen.body as ErrorBody).code).toBe('VALIDATION_ERROR');
  });
});
