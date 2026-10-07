import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AccessControlModule } from './modules/access-control/access-control.module';
import { PermissionsGuard } from './modules/access-control/guards/permissions.guard';
import { AuthModule } from './modules/auth/auth.module';
import { CsrfGuard } from './modules/auth/guards/csrf.guard';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { HealthController } from './health.controller';
import { AuditModule } from './modules/audit/audit.module';
import { FilesModule } from './modules/files/files.module';
import { KpiModule } from './modules/kpi/kpi.module';
import { KpiOkrProposalsModule } from './modules/kpi-okr-proposals/kpi-okr-proposals.module';
import { OkrModule } from './modules/okr/okr.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { PayrollPeriodsModule } from './modules/payroll-periods/payroll-periods.module';
import { RewardConfigModule } from './modules/reward-config/reward-config.module';
import { RevenueModule } from './modules/revenue/revenue.module';
import { TrafficModule } from './modules/traffic/traffic.module';
import { SalaryModule } from './modules/salary/salary.module';
import { TeamPerformanceModule } from './modules/team-performance/team-performance.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AccessControlModule,
    AuthModule,
    OrganizationModule,
    FilesModule,
    AuditModule,
    PayrollPeriodsModule,
    RewardConfigModule,
    KpiModule,
    OkrModule,
    KpiOkrProposalsModule,
    RevenueModule,
    TrafficModule,
    SalaryModule,
    TeamPerformanceModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
