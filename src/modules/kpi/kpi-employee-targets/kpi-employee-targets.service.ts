import { HttpStatus, Injectable } from '@nestjs/common';
import type { PayrollPeriodStatus } from '@prisma/client';
import { AuthorizationService } from '../../access-control/authorization.service';
import { PeriodScopeService } from '../../access-control/period-scope.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import { assertPeriodOpenForDataEntry } from '../../../common/utils/period-stage.util';
import type {
  OverrideEmployeeKpiTargetDto,
  PutEmployeeKpiTargetDto,
} from './dto/employee-kpi-target.dto';

@Injectable()
export class EmployeeKpiTargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditLog: AuditLogService,
    private readonly periodScope: PeriodScopeService = new PeriodScopeService(
      prisma,
    ),
  ) {}

  /**
   * Upsert target theo nhân sự. Chỉ scope TEAM/ALL được phép: permission guard xử lý
   * kpi.leader_approve, còn kiểm tra này bảo đảm một quyền SELF hoặc team khác không thể sửa target.
   */
  async setTarget(
    userId: string,
    periodId: number,
    employeeId: number,
    kpiItemId: number,
    dto: PutEmployeeKpiTargetDto,
    requestedTeamId?: number,
  ) {
    const teamId = await this.assertCanManageTarget(
      userId,
      periodId,
      employeeId,
      kpiItemId,
      'kpi.leader_approve',
      requestedTeamId,
    );

    const existing = await this.prisma.employeeKpiTarget.findUnique({
      where: {
        employeeId_teamId_kpiItemId_payrollPeriodId: {
          employeeId,
          teamId,
          kpiItemId,
          payrollPeriodId: periodId,
        },
      },
    });
    if (existing?.dataSource === 'AUTOMATION_GEN_VIDEO') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Target này được đồng bộ từ VCBI, không thể nhập tay ghi đè',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const target = await tx.employeeKpiTarget.upsert({
        where: {
          employeeId_teamId_kpiItemId_payrollPeriodId: {
            employeeId,
            teamId,
            kpiItemId,
            payrollPeriodId: periodId,
          },
        },
        create: {
          employeeId,
          teamId,
          kpiItemId,
          payrollPeriodId: periodId,
          targetValue: dto.targetValue,
          createdByUserId: userId,
          dataSource: 'MANUAL',
        },
        update: {
          targetValue: dto.targetValue,
          dataSource: 'MANUAL',
          syncedAt: null,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: existing
          ? 'EMPLOYEE_KPI_TARGET_UPDATED'
          : 'EMPLOYEE_KPI_TARGET_CREATED',
        entityType: 'EmployeeKpiTarget',
        entityId: target.id,
        targetEmployeeId: employeeId,
        payrollPeriodId: periodId,
        beforeData: existing
          ? { targetValue: existing.targetValue.toNumber() }
          : undefined,
        afterData: { kpiItemId, targetValue: dto.targetValue },
      });
      return target;
    });
  }

  /** Ghi phần điều chỉnh riêng, không thay đổi mục tiêu gốc hoặc nguồn đồng bộ. */
  async overrideTarget(
    userId: string,
    periodId: number,
    employeeId: number,
    kpiItemId: number,
    dto: OverrideEmployeeKpiTargetDto,
    requestedTeamId?: number,
  ) {
    const teamId = await this.assertCanManageTarget(
      userId,
      periodId,
      employeeId,
      kpiItemId,
      'kpi.override',
      requestedTeamId,
    );
    const key = { employeeId, teamId, kpiItemId, payrollPeriodId: periodId };
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.employeeKpiTarget.findUnique({
        where: { employeeId_teamId_kpiItemId_payrollPeriodId: key },
      });
      const periodTarget = existing
        ? null
        : await tx.kpiPeriodTarget.findUnique({
            where: {
              kpiItemId_payrollPeriodId: {
                kpiItemId,
                payrollPeriodId: periodId,
              },
            },
          });
      const originalValue = existing?.targetValue ?? periodTarget?.targetValue;
      if (originalValue == null) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Chưa có mục tiêu gốc. Hãy nhập mục tiêu trước khi điều chỉnh.',
          HttpStatus.BAD_REQUEST,
        );
      }
      const override = {
        overrideValue: dto.overrideValue,
        overrideReason: dto.reason,
        overriddenByUserId: userId,
        overriddenAt: new Date(),
      };
      const target = await tx.employeeKpiTarget.upsert({
        where: { employeeId_teamId_kpiItemId_payrollPeriodId: key },
        create: {
          ...key,
          targetValue: originalValue,
          createdByUserId: userId,
          dataSource: 'MANUAL',
          ...override,
        },
        update: override,
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'KPI_TARGET_OVERRIDE',
        entityType: 'EmployeeKpiTarget',
        entityId: target.id,
        targetEmployeeId: employeeId,
        payrollPeriodId: periodId,
        beforeData: {
          targetValue: originalValue.toNumber(),
          overrideValue: existing?.overrideValue?.toNumber() ?? null,
        },
        afterData: {
          targetValue: originalValue.toNumber(),
          overrideValue: dto.overrideValue,
        },
        reason: dto.reason,
      });
      return target;
    });
  }

  async clearOverride(
    userId: string,
    periodId: number,
    employeeId: number,
    kpiItemId: number,
    requestedTeamId?: number,
  ) {
    const teamId = await this.assertCanManageTarget(
      userId,
      periodId,
      employeeId,
      kpiItemId,
      'kpi.override',
      requestedTeamId,
    );
    const key = { employeeId, teamId, kpiItemId, payrollPeriodId: periodId };
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.employeeKpiTarget.findUnique({
        where: { employeeId_teamId_kpiItemId_payrollPeriodId: key },
      });
      if (existing?.overrideValue == null) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Mục tiêu này chưa có giá trị điều chỉnh',
          HttpStatus.BAD_REQUEST,
        );
      }
      const target = await tx.employeeKpiTarget.update({
        where: { id: existing.id },
        data: {
          overrideValue: null,
          overrideReason: null,
          overriddenByUserId: null,
          overriddenAt: null,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'KPI_TARGET_OVERRIDE_CLEARED',
        entityType: 'EmployeeKpiTarget',
        entityId: target.id,
        targetEmployeeId: employeeId,
        payrollPeriodId: periodId,
        beforeData: { overrideValue: existing.overrideValue.toNumber() },
        afterData: {
          overrideValue: null,
          effectiveTargetValue: existing.targetValue.toNumber(),
        },
      });
      return target;
    });
  }

  private async assertCanManageTarget(
    userId: string,
    periodId: number,
    employeeId: number,
    kpiItemId: number,
    permissionCode: 'kpi.leader_approve' | 'kpi.override',
    requestedTeamId?: number,
  ) {
    const period = await this.assertPeriodExists(periodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenForDataEntry(period, 'đặt mục tiêu KPI của nhân sự');
    await this.assertEmployeeInPeriod(employeeId, periodId);
    const scope = await this.authorization.resolvePermissionScope(
      userId,
      permissionCode,
    );
    if (scope.type !== 'ALL' && scope.type !== 'TEAM') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Chỉ Leader trở lên mới được đặt hoặc điều chỉnh mục tiêu KPI',
        HttpStatus.FORBIDDEN,
      );
    }
    const item = await this.prisma.kpiItem.findUnique({
      where: { id: kpiItemId },
      select: { kpiGroupId: true },
    });
    if (!item) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy đầu mục KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    const assignments = await this.prisma.employeeKpiAssignment.findMany({
      where: {
        employeeId,
        payrollPeriodId: periodId,
        kpiGroupId: item.kpiGroupId,
        assignmentStatus: 'ASSIGNED',
        teamId: requestedTeamId,
      },
    });
    const visibleAssignments = assignments.filter(
      (assignment) =>
        scope.type === 'ALL' ||
        (scope.type === 'TEAM' && scope.teamIds.includes(assignment.teamId)),
    );
    if (visibleAssignments.length !== 1) {
      throw new AppException(
        visibleAssignments.length === 0
          ? ErrorCode.OUT_OF_SCOPE
          : ErrorCode.VALIDATION_ERROR,
        visibleAssignments.length === 0
          ? 'Đầu mục KPI chưa được gán trong team thuộc phạm vi của bạn'
          : 'KPI tồn tại ở nhiều team; cần truyền teamId',
        visibleAssignments.length === 0
          ? HttpStatus.FORBIDDEN
          : HttpStatus.BAD_REQUEST,
      );
    }
    const teamId = visibleAssignments[0].teamId;
    const inScope = await this.periodScope.includesEmployeeTeam(
      scope,
      periodId,
      employeeId,
      teamId,
      null,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
    return teamId;
  }

  private async assertPeriodExists(periodId: number) {
    const period = await this.prisma.payrollPeriod.findUnique({
      where: { id: periodId },
    });
    if (!period) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy kỳ lương',
        HttpStatus.NOT_FOUND,
      );
    }
    return period;
  }

  private assertPeriodEditable(period: { status: PayrollPeriodStatus }) {
    if (period.status === 'CLOSED') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Kỳ lương đã đóng, không thể thay đổi target KPI',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertEmployeeInPeriod(employeeId: number, periodId: number) {
    const snapshot = await this.prisma.payrollPeriodEmployeeSnapshot.findUnique(
      {
        where: {
          payrollPeriodId_employeeId: { payrollPeriodId: periodId, employeeId },
        },
      },
    );
    if (!snapshot) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự không thuộc kỳ lương này',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
