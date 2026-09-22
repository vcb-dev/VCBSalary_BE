import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

interface ErrorBody {
  code: string;
}

interface ProfileBody {
  email: string;
  roles: { roleCode: string }[];
  permissions: string[];
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

describe('Access control (e2e)', () => {
  let app: INestApplication<App>;
  const prisma = new PrismaClient();

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
    await prisma.$disconnect();
  });

  async function loginAs(email: string, password: string) {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password })
      .expect(201);
    return parseCookies(res.headers['set-cookie'] as unknown as string[]);
  }

  it('rejects an unauthenticated request to a protected endpoint (no bypass without a token)', () => {
    return request(app.getHttpServer()).get('/api/roles').expect(401);
  });

  it('allows Admin (role.view) to list roles, denies Editor (no role.view)', async () => {
    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    await request(app.getHttpServer())
      .get('/api/roles')
      .set('Cookie', cookieHeader(adminCookies))
      .expect(200);

    const editorCookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const res = await request(app.getHttpServer())
      .get('/api/roles')
      .set('Cookie', cookieHeader(editorCookies))
      .expect(403);
    expect((res.body as ErrorBody).code).toBe('FORBIDDEN');
  });

  it('rejects login for a disabled account', async () => {
    const passwordHash = await bcrypt.hash('Disabled@123', 10);
    const disabledUser = await prisma.user.create({
      data: {
        email: 'disabled-test@vcbsalary.vn',
        fullName: 'Disabled Test User',
        passwordHash,
        status: 'DISABLED',
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'disabled-test@vcbsalary.vn', password: 'Disabled@123' })
        .expect(403);
      expect((res.body as ErrorBody).code).toBe('AUTH_ACCOUNT_DISABLED');
    } finally {
      await prisma.user.delete({ where: { id: disabledUser.id } });
    }
  });

  it('rotates the refresh token: the old refresh token cannot be reused', async () => {
    const cookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');

    const refreshed = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(cookies))
      .set('x-csrf-token', cookies.vcbsalary_csrf)
      .expect(201);
    const newCookies = parseCookies(
      refreshed.headers['set-cookie'] as unknown as string[],
    );
    expect(newCookies.vcbsalary_rt).toBeDefined();
    expect(newCookies.vcbsalary_rt).not.toBe(cookies.vcbsalary_rt);

    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(cookies))
      .set('x-csrf-token', cookies.vcbsalary_csrf)
      .expect(401);
  });

  it('returns the current user profile with roles and permissions on /auth/me', async () => {
    const cookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', cookieHeader(cookies))
      .expect(200);

    const body = res.body as ProfileBody;
    expect(body.email).toBe('admin@vcbsalary.vn');
    expect(body.roles.some((r) => r.roleCode === 'ADMIN')).toBe(true);
    expect(body.permissions).toContain('role.manage');
  });
});
