import { HttpStatus, Injectable } from '@nestjs/common';
import type { EmployeeOkr, PayrollPeriodStatus } from '@prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { AuthorizationService } from '../access-control/authorization.service';
import { PeriodScopeService } from '../access-control/period-scope.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertPeriodInReview,
  assertPeriodOpenOrInReview,
  assertPeriodOpenForDataEntry,
} from '../../common/utils/period-stage.util';
import type {
  CreateEmployeeOkrDto,
  LeaderRejectOkrDto,
  OverrideEmployeeOkrDto,
  UpdateEmployeeOkrDto,
} from './dto/employee-okr.dto';

@Injectable()
export class EmployeeOkrsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditLog: AuditLogService,
    private readonly periodScope: PeriodScopeService = new PeriodScopeService(
      prisma,
    ),
  ) {}

  /** progress = MIN(actual/target, 100%) — tính động, không lưu cột riêng (đúng spec M08). */
  async listForEmployee(userId: string, periodId: number, employeeId: number) {
    await this.assertPeriodExists(periodId);
    await this.assertEmployeeExists(employeeId);
    await this.assertVisible(userId, periodId, employeeId);

    const okrs = await this.prisma.employeeOkr.findMany({
      where: { employeeId, payrollPeriodId: periodId },
      orderBy: { createdAt: 'asc' },
    });

    return okrs.map((okr) => ({
      ...okr,
      progressPercent: this.computeProgressPercent(okr),
    }));
  }

  async create(
    userId: string,
    periodId: number,
    employeeId: number,
    dto: CreateEmployeeOkrDto,
  ) {
    const period = await this.assertPeriodExists(periodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenForDataEntry(period, 'tạo OKR');
    await this.assertEmployeeExists(employeeId);
    await this.assertSnapshotExists(periodId, employeeId);

    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'okr.create',
    );
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;
    const inScope = await this.periodScope.includesEmployee(
      scope,
      periodId,
      employeeId,
      selfEmployeeId,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const okr = await tx.employeeOkr.create({
        data: {
          employeeId,
          payrollPeriodId: periodId,
          title: dto.title,
          description: dto.description,
          unit: dto.unit,
          targetValue: dto.targetValue,
          rewardAmount: dto.rewardAmount,
          deadline: dto.deadline ? new Date(dto.deadline) : undefined,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'OKR_CREATED',
        entityType: 'EmployeeOkr',
        entityId: okr.id,
        targetEmployeeId: employeeId,
        payrollPeriodId: periodId,
        afterData: {
          title: dto.title,
          targetValue: dto.targetValue,
          rewardAmount: dto.rewardAmount,
        },
      });
      return { ...okr, progressPercent: this.computeProgressPercent(okr) };
    });
  }

  /** Chỉ sửa được khi còn DRAFT (Draft => confirmed, Rejected => editable, Approved bị khóa). */
  async update(userId: string, id: number, dto: UpdateEmployeeOkrDto) {
    const okr = await this.getOrThrow(id);
    const period = await this.assertPeriodExists(okr.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenOrInReview(period, 'sửa OKR');
    await this.assertOwnOkr(userId, okr);
    this.assertDraftEditable(okr);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeOkr.updateMany({
        where: {
          id,
          selfConfirmationStatus: 'DRAFT',
          leaderReviewStatus: { not: 'APPROVED' },
        },
        data: {
          actualValue: dto.actualValue,
          selfAssessment: dto.selfAssessment,
          overrideValue: null,
          overrideReason: null,
        },
      });
      this.assertClaimed(claimed.count);
      const updated = await tx.employeeOkr.findUniqueOrThrow({ where: { id } });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'OKR_UPDATED',
        entityType: 'EmployeeOkr',
        entityId: id,
        targetEmployeeId: okr.employeeId,
        payrollPeriodId: okr.payrollPeriodId,
        beforeData: {
          actualValue: okr.actualValue.toNumber(),
          selfAssessment: okr.selfAssessment,
        },
        afterData: {
          actualValue: dto.actualValue,
          selfAssessment: dto.selfAssessment,
        },
      });
      return {
        ...updated,
        progressPercent: this.computeProgressPercent(updated),
      };
    });
  }

  /**
   * Xóa OKR khi tạo nhầm — chỉ cho phép lúc còn DRAFT (chưa ai tự xác nhận/duyệt). Hard-delete
   * (không phải soft-cancel như KPI assignment) vì ở trạng thái DRAFT, OKR chưa từng được dùng để
   * tính thưởng/duyệt — chưa phải "dữ liệu nghiệp vụ có lịch sử" theo nguyên tắc chung của hệ
   * thống (khác KPI group/item/assignment, vốn có thể đã gắn actual/lịch sử ngay từ khi tạo).
   * Cùng phạm vi actor với `create()` (Leader/Admin quản lý OKR đã gán) — không dùng `assertOwnOkr`
   * vì người xóa là người quản lý, không phải chủ OKR.
   */
  async remove(userId: string, id: number) {
    const okr = await this.getOrThrow(id);
    const period = await this.assertPeriodExists(okr.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenForDataEntry(period, 'xoá OKR');
    this.assertDraftEditable(okr);

    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'okr.create',
    );
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;
    const inScope = await this.periodScope.includesEmployee(
      scope,
      okr.payrollPeriodId,
      okr.employeeId,
      selfEmployeeId,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.employeeOkr.deleteMany({
        where: {
          id,
          selfConfirmationStatus: 'DRAFT',
          leaderReviewStatus: { not: 'APPROVED' },
        },
      });
      this.assertClaimed(removed.count);
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'OKR_DELETED',
        entityType: 'EmployeeOkr',
        entityId: id,
        targetEmployeeId: okr.employeeId,
        payrollPeriodId: okr.payrollPeriodId,
        beforeData: {
          title: okr.title,
          targetValue: okr.targetValue.toNumber(),
          rewardAmount: okr.rewardAmount.toNumber(),
        },
      });
    });
  }

  async selfConfirm(userId: string, id: number) {
    const okr = await this.getOrThrow(id);
    const period = await this.assertPeriodExists(okr.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodInReview(period, 'tự xác nhận OKR');
    await this.assertOwnOkr(userId, okr);
    this.assertDraftEditable(okr);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeOkr.updateMany({
        where: {
          id,
          selfConfirmationStatus: 'DRAFT',
          leaderReviewStatus: { not: 'APPROVED' },
        },
        data: {
          selfConfirmationStatus: 'CONFIRMED',
          selfConfirmedByUserId: userId,
          selfConfirmedAt: new Date(),
          leaderReviewStatus: 'PENDING',
          leaderRejectionReason: null,
        },
      });
      this.assertClaimed(claimed.count);
      const updated = await tx.employeeOkr.findUniqueOrThrow({ where: { id } });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'OKR_SELF_CONFIRMED',
        entityType: 'EmployeeOkr',
        entityId: id,
        targetEmployeeId: okr.employeeId,
        payrollPeriodId: okr.payrollPeriodId,
      });
      return updated;
    });
  }

  /** Leader (scope TEAM) không tự duyệt OKR của chính mình — Admin (scope ALL) không bị chặn. */
  async leaderApprove(userId: string, id: number) {
    const okr = await this.getOrThrow(id);
    const period = await this.assertPeriodExists(okr.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodInReview(period, 'duyệt OKR');
    await this.assertReviewable(userId, okr);
    this.assertConfirmedForReview(okr);
    this.assertPendingForReview(okr);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeOkr.updateMany({
        where: {
          id,
          selfConfirmationStatus: 'CONFIRMED',
          leaderReviewStatus: 'PENDING',
        },
        data: {
          leaderReviewStatus: 'APPROVED',
          leaderReviewedByUserId: userId,
          leaderReviewedAt: new Date(),
          leaderRejectionReason: null,
        },
      });
      this.assertClaimed(claimed.count);
      const updated = await tx.employeeOkr.findUniqueOrThrow({ where: { id } });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'OKR_LEADER_APPROVED',
        entityType: 'EmployeeOkr',
        entityId: id,
        targetEmployeeId: okr.employeeId,
        payrollPeriodId: okr.payrollPeriodId,
      });
      return updated;
    });
  }

  async leaderReject(userId: string, id: number, dto: LeaderRejectOkrDto) {
    const okr = await this.getOrThrow(id);
    const period = await this.assertPeriodExists(okr.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodInReview(period, 'từ chối OKR');
    await this.assertReviewable(userId, okr);
    this.assertConfirmedForReview(okr);
    this.assertPendingForReview(okr);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeOkr.updateMany({
        where: {
          id,
          selfConfirmationStatus: 'CONFIRMED',
          leaderReviewStatus: 'PENDING',
        },
        data: {
          leaderReviewStatus: 'REJECTED',
          leaderReviewedByUserId: userId,
          leaderReviewedAt: new Date(),
          leaderRejectionReason: dto.reason,
          // "Rejected => editable => resubmit": mở lại cho sửa.
          selfConfirmationStatus: 'DRAFT',
          selfConfirmedByUserId: null,
          selfConfirmedAt: null,
          overrideValue: null,
          overrideReason: null,
        },
      });
      this.assertClaimed(claimed.count);
      const updated = await tx.employeeOkr.findUniqueOrThrow({ where: { id } });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'OKR_LEADER_REJECTED',
        entityType: 'EmployeeOkr',
        entityId: id,
        targetEmployeeId: okr.employeeId,
        payrollPeriodId: okr.payrollPeriodId,
        reason: dto.reason,
      });
      return updated;
    });
  }

  /** Leader điều chỉnh kết quả đã xác nhận trước khi duyệt; giữ số nhân sự nhập để đối chiếu. */
  async override(userId: string, id: number, dto: OverrideEmployeeOkrDto) {
    const okr = await this.getOrThrow(id);
    const period = await this.assertPeriodExists(okr.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodInReview(period, 'điều chỉnh OKR');
    await this.assertReviewable(userId, okr);
    this.assertConfirmedForReview(okr);
    this.assertPendingForReview(okr);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeOkr.updateMany({
        where: {
          id,
          selfConfirmationStatus: 'CONFIRMED',
          leaderReviewStatus: 'PENDING',
        },
        data: {
          overrideValue: dto.overrideValue,
          overrideReason: dto.reason,
        },
      });
      this.assertClaimed(claimed.count);
      const updated = await tx.employeeOkr.findUniqueOrThrow({ where: { id } });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'OKR_ACTUAL_OVERRIDE',
        entityType: 'EmployeeOkr',
        entityId: id,
        targetEmployeeId: okr.employeeId,
        payrollPeriodId: okr.payrollPeriodId,
        beforeData: {
          actualValue: okr.actualValue.toNumber(),
          overrideValue: okr.overrideValue?.toNumber() ?? null,
        },
        afterData: { overrideValue: dto.overrideValue },
        reason: dto.reason,
      });
      return {
        ...updated,
        progressPercent: this.computeProgressPercent(updated),
      };
    });
  }

  private computeProgressPercent(okr: EmployeeOkr): number {
    const target = okr.targetValue.toNumber();
    const actual = (okr.overrideValue ?? okr.actualValue).toNumber();
    if (target <= 0) return 0;
    return Math.min(actual / target, 1) * 100;
  }

  private async assertVisible(
    userId: string,
    periodId: number,
    employeeId: number,
  ) {
    const scope = await this.authorization.resolveScope(userId, 'okr');
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;
    const inScope = await this.periodScope.includesEmployee(
      scope,
      periodId,
      employeeId,
      selfEmployeeId,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertOwnOkr(userId: string, okr: EmployeeOkr) {
    const selfEmployeeId = await this.authorization.getEmployeeId(userId);
    if (!selfEmployeeId || selfEmployeeId !== okr.employeeId) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Chỉ có thể thao tác trên OKR của chính mình',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertReviewable(userId: string, okr: EmployeeOkr) {
    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'okr.leader_approve',
    );
    if (scope.type !== 'TEAM' && scope.type !== 'ALL') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Chỉ Leader hoặc Admin được duyệt và điều chỉnh OKR',
        HttpStatus.FORBIDDEN,
      );
    }
    const actorEmployeeId = await this.authorization.getEmployeeId(userId);
    if (scope.type === 'TEAM' && actorEmployeeId === okr.employeeId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Không thể tự duyệt OKR của chính mình',
        HttpStatus.FORBIDDEN,
      );
    }
    const inScope = await this.periodScope.includesEmployee(
      scope,
      okr.payrollPeriodId,
      okr.employeeId,
      null,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertDraftEditable(okr: EmployeeOkr) {
    if (okr.selfConfirmationStatus !== 'DRAFT') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'OKR đã xác nhận hoặc đã được duyệt, không thể sửa trực tiếp',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertConfirmedForReview(okr: EmployeeOkr) {
    if (okr.selfConfirmationStatus !== 'CONFIRMED') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'OKR chưa được nhân sự tự xác nhận, chưa thể duyệt/từ chối',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertPendingForReview(okr: EmployeeOkr) {
    if (okr.leaderReviewStatus !== 'PENDING') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'OKR đã được duyệt, không thể duyệt hoặc từ chối lại',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertClaimed(count: number) {
    if (count !== 1) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'OKR vừa được thay đổi bởi một yêu cầu khác, vui lòng tải lại',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async getOrThrow(id: number) {
    const okr = await this.prisma.employeeOkr.findUnique({ where: { id } });
    if (!okr) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy OKR',
        HttpStatus.NOT_FOUND,
      );
    }
    return okr;
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
        'Kỳ lương đã đóng, không thể thay đổi dữ liệu OKR',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertEmployeeExists(employeeId: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhân sự',
        HttpStatus.NOT_FOUND,
      );
    }
    return employee;
  }

  private async assertSnapshotExists(periodId: number, employeeId: number) {
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
        'Nhân sự không thuộc kỳ lương này (chưa có trong snapshot khi mở kỳ)',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
