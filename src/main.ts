import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  if (config.get<string>('TRUST_PROXY', 'false') === 'true') {
    (app.getHttpAdapter().getInstance() as Express).set('trust proxy', 1);
  }

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.enableCors({
    origin: config
      .get<string>('FE_ORIGIN', 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Authorization'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerEnabled =
    config.get<string>('SWAGGER_ENABLED') === 'true' ||
    (config.get<string>('SWAGGER_ENABLED') === undefined &&
      config.get<string>('NODE_ENV') !== 'production');
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('VCB Salary API')
      .setDescription('API cho Hệ thống Tính lương & Thưởng VCB Salary')
      .setVersion('0.0.1')
      .addCookieAuth('vcbsalary_at')
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, swaggerDocument);
  }

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
}

void bootstrap().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Không thể khởi động VCB Salary API: ${message}\n`);
  process.exitCode = 1;
});
