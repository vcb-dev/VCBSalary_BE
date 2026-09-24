import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, PayrollPeriodStatus } from '@prisma/client';
import { AuditLogService } from '../../audit/audit-log.service';
import { AuthorizationService } from '../../access-control/authorization.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import { assertPeriodOpenForDataEntry } from '../../../common/utils/period-stage.util';
import { PeriodScopeService } from '../../access-control/period-scope.service';
import type { CreateKpiAssignmentDto } from './dto/kpi-assignment.dto';

@Injectable()
export class KpiAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditLog: AuditLogService,
    private readonly periodScope: PeriodScopeService = new PeriodScopeService(
      prisma,
    ),
  ) {}

  async listForPeriod(
    userId: string,
    periodId: number,
    employeeIdFilter?: number,
    teamIdFilter?: number,
  ) {
    const scope = await this.authorization.resolveScope(userId, 'kpi');
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;

    const where: Prisma.EmployeeKpiAssignmentWhereInput = {
      AND: [
        { payrollPeriodId: periodId },
        employeeIdFilter ? { employeeId: employeeIdFilter } : {},
        teamIdFilter ? { teamId: teamIdFilter } : {},
        scope.type === 'ALL'
          ? {}
          : {
              employee: this.periodScope.employeeWhere(
                scope,
                periodId,
                selfEmployeeId,
              ),
            },
      ],
    };

    // Kiểm tra kỳ chạy song song với truy vấn danh sách; kỳ không tồn tại vẫn trả 404 như cũ.
    const [, assignments] = await Promise.all([
      this.assertPeriodExists(periodId),
      this.prisma.employeeKpiAssignment.findMany({
        where,
        include: {
          employee: {
            select: { id: true, employeeCode: true, fullName: true },
          },
          kpiGroup: { select: { id: true, code: true, name: true } },
          team: { select: { id: true, code: true, name: true } },
        },
        orderBy: [
          { employee: { fullName: 'asc' } },
          { kpiGroup: { name: 'asc' } },
        ],
      }),
    ]);
    return assignments;
  }

  /**
   * Gán 1 KpiGroup cho 1 nhân sự trong kỳ. Tự tạo kèm EmployeeKpiActual (0/DRAFT/PENDING) cho mọi
   * KpiItem đang active của group — để nhân sự nhập actual ngay mà không cần thao tác thêm. Nếu
   * gọi lại sau khi đã CANCELLED trước đó, kích hoạt lại (idempotent) thay vì tạo dòng mới.
   */
  async create(userId: string, periodId: number, dto: CreateKpiAssignmentDto) {
    const period = await this.assertPeriodExists(periodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenForDataEntry(period, 'gán nhóm KPI cho nhân sự');

    const group = await this.prisma.kpiGroup.findUnique({
      where: { id: dto.kpiGroupId },
      include: { teams: true, items: { where: { isActive: true } } },
    });
    if (!group) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhóm KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!group.isActive) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhóm KPI đang bị tắt, không thể gán',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Chỉ gán được cho nhân sự thực sự thuộc kỳ này (có snapshot khi mở kỳ).
    const snapshot = await this.prisma.payrollPeriodEmployeeSnapshot.findUnique(
      {
        where: {
          payrollPeriodId_employeeId: {
            payrollPeriodId: periodId,
            employeeId: dto.employeeId,
          },
        },
      },
    );
    if (!snapshot) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự không thuộc kỳ lương này (chưa có trong snapshot khi mở kỳ)',
        HttpStatus.BAD_REQUEST,
      );
    }
    const teamId = dto.teamId ?? snapshot.teamIdSnapshot;
    if (!teamId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Không xác định được team cho KPI',
        HttpStatus.BAD_REQUEST,
      );
    }
    const membershipSnapshot =
      await this.prisma.payrollPeriodEmployeeTeamSnapshot.findUnique({
        where: {
          payrollPeriodId_employeeId_teamId: {
            payrollPeriodId: periodId,
            employeeId: dto.employeeId,
            teamId,
          },
        },
      });
    if (!membershipSnapshot) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự không thuộc team này trong snapshot kỳ lương',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      (group.teams ?? []).length > 0 &&
      !(group.teams ?? []).some((team) => team.id === teamId)
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhóm KPI này chưa được cấu hình cho team của nhân sự',
        HttpStatus.BAD_REQUEST,
      );
    }

    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'kpi.assign',
    );
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;
    const inScope = await this.periodScope.includesEmployeeTeam(
      scope,
      periodId,
      dto.employeeId,
      teamId,
      selfEmployeeId,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    const existing = await this.prisma.employeeKpiAssignment.findUnique({
      where: {
        employeeId_teamId_kpiGroupId_payrollPeriodId: {
          employeeId: dto.employeeId,
          teamId,
          kpiGroupId: dto.kpiGroupId,
          payrollPeriodId: periodId,
        },
      },
    });
    if (existing?.assignmentStatus === 'ASSIGNED') {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Nhân sự đã được gán nhóm KPI này trong kỳ',
        HttpStatus.CONFLICT,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const assignment = existing
        ? await tx.employeeKpiAssignment.update({
            where: { id: existing.id },
            data: {
              assignmentStatus: 'ASSIGNED',
              assignedByUserId: userId,
              assignedAt: new Date(),
            },
          })
        : await tx.employeeKpiAssignment.create({
            data: {
              employeeId: dto.employeeId,
              teamId,
              kpiGroupId: dto.kpiGroupId,
              payrollPeriodId: periodId,
              assignedByUserId: userId,
            },
          });

      if (group.items.length > 0) {
        await tx.employeeKpiActual.createMany({
          data: group.items.map((item) => ({
            employeeId: dto.employeeId,
            teamId,
            kpiItemId: item.id,
            payrollPeriodId: periodId,
          })),
          skipDuplicates: true,
        });
      }

      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'KPI_ASSIGNMENT_CREATED',
        entityType: 'EmployeeKpiAssignment',
        entityId: assignment.id,
        targetEmployeeId: dto.employeeId,
        payrollPeriodId: periodId,
        afterData: { kpiGroupId: dto.kpiGroupId },
      });

      return assignment;
    });
  }

  /** Soft-cancel (giữ lịch sử) — không xóa cứng, không đụng tới các EmployeeKpiActual đã tạo. */
  async cancel(userId: string, periodId: number, assignmentId: number) {
    const period = await this.assertPeriodExists(periodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenForDataEntry(period, 'gỡ nhóm KPI của nhân sự');

    const assignment = await this.getOrThrow(assignmentId);
    if (assignment.payrollPeriodId !== periodId) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy bản gán KPI trong kỳ này',
        HttpStatus.NOT_FOUND,
      );
    }

    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'kpi.assign',
    );
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;
    const inScope = await this.periodScope.includesEmployeeTeam(
      scope,
      periodId,
      assignment.employeeId,
      assignment.teamId,
      selfEmployeeId,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    if (assignment.assignmentStatus === 'CANCELLED') return; // idempotent

    await this.prisma.$transaction(async (tx) => {
      await tx.employeeKpiAssignment.update({
        where: { id: assignmentId },
        data: { assignmentStatus: 'CANCELLED' },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'KPI_ASSIGNMENT_CANCELLED',
        entityType: 'EmployeeKpiAssignment',
        entityId: assignmentId,
        targetEmployeeId: assignment.employeeId,
        payrollPeriodId: periodId,
      });
    });
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
        'Kỳ lương đã đóng, không thể thay đổi gán KPI',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async getOrThrow(id: number) {
    const assignment = await this.prisma.employeeKpiAssignment.findUnique({
      where: { id },
    });
    if (!assignment) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy bản gán KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    return assignment;
  }
}
