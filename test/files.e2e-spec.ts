import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { SupabaseStorageClient } from '../src/modules/files/clients/supabase-storage.client';

interface ErrorBody {
  code: string;
}

interface FileBody {
  id: string;
  originalFileName: string;
  mimeType: string;
  fileSizeBytes: number;
  downloadUrl?: string;
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

describe('Files (e2e)', () => {
  let app: INestApplication<App>;
  const mockStorage = {
    upload: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    createSignedUrl: jest.fn().mockResolvedValue('https://signed.example/f'),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SupabaseStorageClient)
      .useValue(mockStorage)
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

  it('rejects an upload with no file field', async () => {
    const cookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const res = await withAuth(
      request(app.getHttpServer()).post('/api/files'),
      cookies,
    ).expect(400);
    expect((res.body as ErrorBody).code).toBe('VALIDATION_ERROR');
  });

  it('rejects a disallowed file type', async () => {
    const cookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const res = await withAuth(
      request(app.getHttpServer()).post('/api/files'),
      cookies,
    )
      .attach('file', Buffer.from('MZ-fake-exe'), {
        filename: 'virus.exe',
        contentType: 'application/x-msdownload',
      })
      .expect(400);
    expect((res.body as ErrorBody).code).toBe('VALIDATION_ERROR');
    expect(mockStorage.upload).not.toHaveBeenCalled();
  });

  it('uploads a valid file, lets the owner view/download it, then delete it', async () => {
    const cookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');

    const uploadRes = await withAuth(
      request(app.getHttpServer()).post('/api/files'),
      cookies,
    )
      .attach('file', Buffer.from('%PDF-1.4 fake evidence'), {
        filename: 'minh-chung.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const uploaded = uploadRes.body as FileBody;
    expect(uploaded.mimeType).toBe('application/pdf');
    expect(uploaded.fileSizeBytes).toBeGreaterThan(0);
    expect(uploaded).not.toHaveProperty('storageKey');
    expect(mockStorage.upload).toHaveBeenCalledTimes(1);

    const getRes = await withAuth(
      request(app.getHttpServer()).get(`/api/files/${uploaded.id}`),
      cookies,
    ).expect(200);
    expect((getRes.body as FileBody).downloadUrl).toBe(
      'https://signed.example/f',
    );

    await withAuth(
      request(app.getHttpServer()).delete(`/api/files/${uploaded.id}`),
      cookies,
    ).expect(204);
    expect(mockStorage.remove).toHaveBeenCalledTimes(1);

    await withAuth(
      request(app.getHttpServer()).get(`/api/files/${uploaded.id}`),
      cookies,
    ).expect(404);
  });

  it('blocks a non-owner from viewing or deleting someone else’s file', async () => {
    const editorCookies = await loginAs('editor@vcbsalary.vn', 'Admin@123');
    const uploadRes = await withAuth(
      request(app.getHttpServer()).post('/api/files'),
      editorCookies,
    )
      .attach('file', Buffer.from('%PDF-1.4 another file'), {
        filename: 'khac.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const fileId = (uploadRes.body as FileBody).id;

    const adminCookies = await loginAs('admin@vcbsalary.vn', 'Admin@123');
    const forbiddenGet = await withAuth(
      request(app.getHttpServer()).get(`/api/files/${fileId}`),
      adminCookies,
    ).expect(403);
    expect((forbiddenGet.body as ErrorBody).code).toBe('OUT_OF_SCOPE');

    const forbiddenDelete = await withAuth(
      request(app.getHttpServer()).delete(`/api/files/${fileId}`),
      adminCookies,
    ).expect(403);
    expect((forbiddenDelete.body as ErrorBody).code).toBe('OUT_OF_SCOPE');
  });
});
