import { HttpStatus, Injectable } from '@nestjs/common';
import { AutomationGenVideoClient } from '../../../common/clients/automation-gen-video.client';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthorizationService } from '../../access-control/authorization.service';
import { PeriodScopeService } from '../../access-control/period-scope.service';
import type { TaskComplianceQueryDto } from './dto/task-compliance-query.dto';

const SOURCE_SYSTEM = 'AUTOMATION_GEN_VIDEO';

@Injectable()
export class TaskComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly periodScope: PeriodScopeService,
    private readonly automationGenVideo: AutomationGenVideoClient,
  ) {}

  async getForEmployee(
    userId: string,
    periodId: number,
    employeeId: number,
    query: TaskComplianceQueryDto,
  ) {
    const [period, employee, identity, scope] = await Promise.all([
      this.prisma.payrollPeriod.findUnique({
        where: { id: periodId },
        select: { id: true, startDate: true, endDate: true },
      }),
      this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, externalId: true, sourceSystem: true },
      }),
      this.prisma.externalEmployeeIdentity.findFirst({
        where: { employeeId, sourceSystem: SOURCE_SYSTEM },
        select: { externalUserId: true },
      }),
      this.authorization.resolveScope(userId, 'kpi'),
    ]);

    if (!period) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy kỳ lương',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!employee) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhân sự',
        HttpStatus.NOT_FOUND,
      );
    }

    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;
    const inScope = query.teamId
      ? await this.periodScope.includesEmployeeTeam(
          scope,
          periodId,
          employeeId,
          query.teamId,
          selfEmployeeId,
        )
      : await this.periodScope.includesEmployee(
          scope,
          periodId,
          employeeId,
          selfEmployeeId,
        );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự hoặc team này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    const teamSnapshot =
      await this.prisma.payrollPeriodEmployeeTeamSnapshot.findFirst({
        where: {
          payrollPeriodId: periodId,
          employeeId,
          ...(query.teamId
            ? { teamId: query.teamId }
            : scope.type === 'TEAM'
              ? { teamId: { in: scope.teamIds } }
              : {}),
        },
        select: {
          teamId: true,
          isPrimary: true,
          team: {
            select: { id: true, name: true, externalId: true },
          },
        },
        orderBy: [{ isPrimary: 'desc' }, { teamId: 'asc' }],
      });
    if (!teamSnapshot) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Nhân sự không thuộc team nào trong kỳ lương này',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!teamSnapshot.team.externalId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Team ${teamSnapshot.team.name} chưa được liên kết với VCBI`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const externalUserId =
      identity?.externalUserId ??
      (employee.sourceSystem === SOURCE_SYSTEM ? employee.externalId : null);
    if (!externalUserId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự chưa được liên kết với tài khoản VCBI',
        HttpStatus.BAD_REQUEST,
      );
    }

    const response =
      await this.automationGenVideo.fetchTaskComplianceForPayrollSync(
        teamSnapshot.team.externalId,
        {
          dateFrom: toDateOnly(period.startDate),
          dateTo: toDateOnly(period.endDate),
          externalUserId,
          page: query.page,
          limit: query.pageSize,
        },
      );

    return {
      ...response,
      local_context: {
        payroll_period_id: periodId,
        employee_id: employeeId,
        team_id: teamSnapshot.team.id,
        team_name: teamSnapshot.team.name,
      },
    };
  }
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
