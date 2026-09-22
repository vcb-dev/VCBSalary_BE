import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

interface ErrorBody {
  code: string;
  message: string;
  details?: { errors?: unknown[] };
}

describe('Global error handling (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a standardized {code, message} body on validation failure', () => {
    return request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'not-an-email' })
      .expect(400)
      .expect((res) => {
        const body = res.body as ErrorBody;
        expect(body.code).toBe('VALIDATION_ERROR');
        expect(typeof body.message).toBe('string');
        expect(body.details?.errors).toBeInstanceOf(Array);
      });
  });

  it('returns 401 with a stable error code on invalid credentials', () => {
    return request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'nobody@vcbsalary.vn', password: 'wrong-password' })
      .expect(401)
      .expect((res) => {
        expect((res.body as ErrorBody).code).toBe('AUTH_INVALID_CREDENTIALS');
      });
  });

  it('stamps every response with an X-Request-Id header', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect((res) => {
        expect(res.headers['x-request-id']).toBeTruthy();
      });
  });
});
