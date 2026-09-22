import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  EmployeeKpiActual,
  LeaderReviewStatus,
  PayrollPeriodStatus,
} from '@prisma/client';
import { AuditLogService } from '../../audit/audit-log.service';
import { AuthorizationService } from '../../access-control/authorization.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import { PeriodScopeService } from '../../access-control/period-scope.service';
import {
  assertPeriodInReview,
  assertPeriodOpenOrInReview,
} from '../../payroll-periods/period-stage.util';
import type {
  LeaderRejectKpiDto,
  ManualKpiActualDto,
  OverrideKpiActualDto,
  UpdateEmployeeKpiActualDto,
} from './dto/kpi-actual.dto';

@Injectable()
export class KpiActualsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditLog: AuditLogService,
    private readonly periodScope: PeriodScopeService = new PeriodScopeService(
      prisma,
    ),
  ) {}

  /**
   * Hồ sơ KPI của 1 nhân sự trong 1 kỳ: mọi KpiGroup đang ASSIGNED, kèm target/actual/effective/
   * capped từng item + progress theo group (SUM(capped)/SUM(target), đúng công thức spec — không
   * dùng average của % từng item, không cho item vượt target bù item khác).
   *
   * Lazy-ensure: tự tạo EmployeeKpiActual còn thiếu (item mới thêm vào group sau khi đã assign)
   * ngay trước khi đọc — idempotent (chỉ tạo dòng thiếu, không sửa dòng đã có), tránh phải làm một
   * cơ chế đồng bộ riêng khi thứ tự "assign group" / "thêm item" / "set target" không cố định.
   */
  async getProfile(userId: string, periodId: number, employeeId: number) {
    await this.assertPeriodExists(periodId);
    await this.assertEmployeeExists(employeeId);

    const scope = await this.authorization.resolveScope(userId, 'kpi');
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

    const assignments = await this.prisma.employeeKpiAssignment.findMany({
      where: {
        employeeId,
        payrollPeriodId: periodId,
        assignmentStatus: 'ASSIGNED',
        ...(scope.type === 'TEAM' ? { teamId: { in: scope.teamIds } } : {}),
      },
      include: {
        team: { select: { id: true, code: true, name: true } },
        kpiGroup: {
          include: {
            items: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } },
          },
        },
      },
      orderBy: { kpiGroup: { name: 'asc' } },
    });

    const allItemIds = [
      ...new Set(assignments.flatMap((a) => a.kpiGroup.items.map((i) => i.id))),
    ];
    if (allItemIds.length > 0) {
      await this.prisma.employeeKpiActual.createMany({
        data: assignments.flatMap((assignment) =>
          assignment.kpiGroup.items.map((item) => ({
            employeeId,
            teamId: assignment.teamId,
            kpiItemId: item.id,
            payrollPeriodId: periodId,
          })),
        ),
        skipDuplicates: true,
      });
    }

    const [actuals, periodTargets, employeeTargets] = await Promise.all([
      this.prisma.employeeKpiActual.findMany({
        where: {
          employeeId,
          payrollPeriodId: periodId,
          teamId: { in: assignments.map((assignment) => assignment.teamId) },
          kpiItemId: { in: allItemIds },
        },
      }),
      this.prisma.kpiPeriodTarget.findMany({
        where: { payrollPeriodId: periodId, kpiItemId: { in: allItemIds } },
      }),
      this.prisma.employeeKpiTarget.findMany({
        where: {
          employeeId,
          payrollPeriodId: periodId,
          teamId: { in: assignments.map((assignment) => assignment.teamId) },
          kpiItemId: { in: allItemIds },
        },
      }),
    ]);
    const teamItemKey = (teamId: number, itemId: number) =>
      `${teamId}:${itemId}`;
    const actualByItemId = new Map(
      actuals.map((a) => [teamItemKey(a.teamId ?? 0, a.kpiItemId), a]),
    );
    const periodTargetByItemId = new Map(
      periodTargets.map((target) => [target.kpiItemId, target]),
    );
    const employeeTargetByItemId = new Map(
      employeeTargets.map((target) => [
        teamItemKey(target.teamId ?? 0, target.kpiItemId),
        target,
      ]),
    );

    const groups = assignments.map((assignment) => {
      const assignmentTeamId = assignment.teamId ?? 0;
      const items = assignment.kpiGroup.items.map((item) => {
        const actual = actualByItemId.get(
          teamItemKey(assignmentTeamId, item.id),
        );
        // Ưu tiên target leader đặt riêng cho nhân sự; nếu chưa có thì dùng target mặc định kỳ.
        const employeeTarget = employeeTargetByItemId.get(
          teamItemKey(assignmentTeamId, item.id),
        );
        const target = employeeTarget ?? periodTargetByItemId.get(item.id);
        const effectiveTarget =
          employeeTarget?.overrideValue ?? target?.targetValue ?? null;
        const targetValueNumber = effectiveTarget?.toNumber() ?? null;
        const actualValueNumber = actual ? actual.actualValue.toNumber() : 0;
        const overrideValueNumber =
          actual?.overrideValue != null
            ? actual.overrideValue.toNumber()
            : null;
        // effective_actual = override_value ?? actual_value (đúng công thức spec M07).
        const effectiveActualValue = overrideValueNumber ?? actualValueNumber;
        // capped_actual = MIN(effective_actual, target) — không giới hạn nếu chưa có target.
        const cappedActualValue =
          targetValueNumber != null
            ? Math.min(effectiveActualValue, targetValueNumber)
            : effectiveActualValue;

        return {
          actualId: actual?.id ?? null,
          kpiItemId: item.id,
          kpiItemCode: item.code,
          kpiItemName: item.name,
          kpiItemUnit: item.unit,
          // targetValue/actualValue/overrideValue: Decimal Prisma — serialize thành string trong
          // JSON (không phải number), khớp quy ước đã áp dụng cho toàn hệ thống.
          targetValue: effectiveTarget,
          targetOriginalValue: target?.targetValue ?? null,
          targetOverrideValue: employeeTarget?.overrideValue ?? null,
          targetOverrideReason: employeeTarget?.overrideReason ?? null,
          targetSource: employeeTarget
            ? 'EMPLOYEE'
            : target
              ? 'PERIOD'
              : 'NONE',
          targetDataSource: employeeTarget?.dataSource ?? null,
          targetSyncedAt: employeeTarget?.syncedAt ?? null,
          actualValue: actual?.actualValue ?? null,
          dataSource: actual?.dataSource ?? 'MANUAL',
          syncedAt: actual?.syncedAt ?? null,
          requiresManualEntry: actual?.requiresManualEntry ?? false,
          manualEnteredAt: actual?.manualEnteredAt ?? null,
          syncMessage: actual?.syncMessage ?? null,
          overrideValue: actual?.overrideValue ?? null,
          overrideReason: actual?.overrideReason ?? null,
          // effectiveActualValue/cappedActualValue: giá trị TÍNH TOÁN — number thật, không phải
          // Decimal, nên là number (không phải string) trong JSON.
          effectiveActualValue,
          cappedActualValue,
          selfAssessment: actual?.selfAssessment ?? null,
          selfConfirmationStatus: actual?.selfConfirmationStatus ?? 'DRAFT',
          leaderReviewStatus: actual?.leaderReviewStatus ?? 'PENDING',
          leaderRejectionReason: actual?.leaderRejectionReason ?? null,
        };
      });

      const sumTarget = items.reduce(
        (sum, i) => sum + (i.targetValue ? i.targetValue.toNumber() : 0),
        0,
      );
      const sumCapped = items.reduce((sum, i) => sum + i.cappedActualValue, 0);

      return {
        assignmentId: assignment.id,
        teamId: assignmentTeamId,
        teamCode: assignment.team?.code ?? '',
        teamName: assignment.team?.name ?? 'Team chính',
        kpiGroupId: assignment.kpiGroup.id,
        kpiGroupCode: assignment.kpiGroup.code,
        kpiGroupName: assignment.kpiGroup.name,
        dataSource: assignment.kpiGroup.dataSource,
        // progressPercent: number (%) — null nếu group chưa có target nào (tránh chia 0).
        progressPercent: sumTarget > 0 ? (sumCapped / sumTarget) * 100 : null,
        items,
      };
    });

    return { employeeId, payrollPeriodId: periodId, groups };
  }

  /** Chỉ sửa được khi còn DRAFT (Draft => confirmed, Rejected => editable, Approved bị khóa). */
  async updateActual(
    userId: string,
    id: number,
    dto: UpdateEmployeeKpiActualDto,
  ) {
    const actual = await this.getActualOrThrow(id);
    const period = await this.assertPeriodExists(actual.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenOrInReview(period, 'nhập actual KPI');
    await this.assertOwnActual(userId, actual);
    this.assertDraftEditable(actual);
    if (
      actual.dataSource === 'AUTOMATION_GEN_VIDEO' &&
      !actual.requiresManualEntry
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Actual này được đồng bộ từ AutomationGenVideo, không thể nhập trực tiếp',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeKpiActual.updateMany({
        where: {
          id,
          selfConfirmationStatus: 'DRAFT',
          leaderReviewStatus: { not: 'APPROVED' },
          OR: [
            { dataSource: { not: 'AUTOMATION_GEN_VIDEO' } },
            { requiresManualEntry: true },
          ],
        },
        data: {
          actualValue: dto.actualValue,
          selfAssessment: dto.selfAssessment,
          overrideValue: null,
          overrideReason: null,
          dataSource: 'MANUAL',
          syncedAt: null,
          requiresManualEntry: false,
          manualEnteredAt: new Date(),
        },
      });
      this.assertClaimed(claimed.count);
      const updated = await tx.employeeKpiActual.findUniqueOrThrow({
        where: { id },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'KPI_ACTUAL_UPDATED',
        entityType: 'EmployeeKpiActual',
        entityId: id,
        targetEmployeeId: actual.employeeId,
        payrollPeriodId: actual.payrollPeriodId,
        beforeData: {
          actualValue: actual.actualValue.toNumber(),
          selfAssessment: actual.selfAssessment,
        },
        afterData: {
          actualValue: dto.actualValue,
          selfAssessment: dto.selfAssessment,
        },
      });
      return updated;
    });
  }

  /** Leader/Admin nhập thay khi API nguồn trả actual=null. */
  async manualEntry(userId: string, id: number, dto: ManualKpiActualDto) {
    const actual = await this.getActualOrThrow(id);
    const period = await this.assertPeriodExists(actual.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenOrInReview(period, 'nhập thay actual KPI');
    this.assertDraftEditable(actual);
    if (!actual.requiresManualEntry) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Đầu mục này không được đánh dấu là thiếu dữ liệu nguồn',
        HttpStatus.BAD_REQUEST,
      );
    }

    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'kpi.override',
    );
    if (scope.type !== 'ALL' && scope.type !== 'TEAM') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Chỉ Leader hoặc Admin được nhập tay thay cho nhân sự',
        HttpStatus.FORBIDDEN,
      );
    }
    const inScope = await this.periodScope.includesEmployeeTeam(
      scope,
      actual.payrollPeriodId,
      actual.employeeId,
      actual.teamId,
      null,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeKpiActual.updateMany({
        where: {
          id,
          selfConfirmationStatus: 'DRAFT',
          leaderReviewStatus: { not: 'APPROVED' },
          requiresManualEntry: true,
        },
        data: {
          actualValue: dto.actualValue,
          selfAssessment: dto.note ?? actual.selfAssessment,
          overrideValue: null,
          overrideReason: null,
          dataSource: 'MANUAL',
          syncedAt: null,
          requiresManualEntry: false,
          manualEnteredAt: new Date(),
          syncMessage:
            'Đã nhập tay do nguồn AutomationGenVideo không có actual',
        },
      });
      this.assertClaimed(claimed.count);
      const updated = await tx.employeeKpiActual.findUniqueOrThrow({
        where: { id },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'KPI_ACTUAL_MANUAL_ENTRY',
        entityType: 'EmployeeKpiActual',
        entityId: id,
        targetEmployeeId: actual.employeeId,
        payrollPeriodId: actual.payrollPeriodId,
        beforeData: { actualValue: actual.actualValue.toString() },
        afterData: { actualValue: dto.actualValue, source: 'MANUAL' },
        reason: dto.note,
      });
      return updated;
    });
  }

  /** Resubmit sau khi bị reject cũng đi qua đây — reset leaderReviewStatus về PENDING, xóa reason cũ. */
  async selfConfirm(userId: string, id: number) {
    const actual = await this.getActualOrThrow(id);
    const period = await this.assertPeriodExists(actual.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodInReview(period, 'tự xác nhận KPI');
    await this.assertOwnActual(userId, actual);
    this.assertDraftEditable(actual);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeKpiActual.updateMany({
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
      const updated = await tx.employeeKpiActual.findUniqueOrThrow({
        where: { id },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'KPI_ACTUAL_SELF_CONFIRMED',
        entityType: 'EmployeeKpiActual',
        entityId: id,
        targetEmployeeId: actual.employeeId,
        payrollPeriodId: actual.payrollPeriodId,
      });
      return updated;
    });
  }

  /**
   * Duyệt/từ chối theo GROUP (đúng URL spec: kpi-groups/:groupId/employees/:employeeId/periods/
   * :periodId/leader-approve|reject) — áp dụng cho TOÀN BỘ actual thuộc group đó của nhân sự trong
   * kỳ cùng lúc, đòi hỏi tất cả đã CONFIRMED trước (group phải "nộp đủ" mới duyệt được).
   */
  async leaderApprove(
    userId: string,
    groupId: number,
    employeeId: number,
    periodId: number,
    teamId?: number,
  ) {
    return this.reviewGroup(
      userId,
      groupId,
      employeeId,
      periodId,
      'APPROVED',
      undefined,
      teamId,
    );
  }

  async leaderReject(
    userId: string,
    groupId: number,
    employeeId: number,
    periodId: number,
    dto: LeaderRejectKpiDto,
    teamId?: number,
  ) {
    return this.reviewGroup(
      userId,
      groupId,
      employeeId,
      periodId,
      'REJECTED',
      dto.reason,
      teamId,
    );
  }

  /**
   * Override: chỉ Leader/Admin (kpi.override). Leader (scope TEAM) không được override chính
   * mình — Admin (scope ALL) không bị chặn (test "Admin override" liệt kê riêng, không có rule
   * cấm Admin tự override trong spec).
   */
  async override(userId: string, id: number, dto: OverrideKpiActualDto) {
    const actual = await this.getActualOrThrow(id);
    const period = await this.assertPeriodExists(actual.payrollPeriodId);
    this.assertPeriodEditable(period);
    assertPeriodOpenOrInReview(period, 'điều chỉnh actual KPI');
    if (actual.leaderReviewStatus === 'APPROVED') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'KPI đã được duyệt, không thể điều chỉnh',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      period.status === 'IN_REVIEW' &&
      actual.selfConfirmationStatus !== 'CONFIRMED'
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự cần tự xác nhận KPI trước khi Leader điều chỉnh',
        HttpStatus.BAD_REQUEST,
      );
    }

    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'kpi.override',
    );
    if (scope.type !== 'TEAM' && scope.type !== 'ALL') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Chỉ Leader hoặc Admin được điều chỉnh KPI',
        HttpStatus.FORBIDDEN,
      );
    }
    const actorEmployeeId = await this.authorization.getEmployeeId(userId);
    if (scope.type === 'TEAM' && actorEmployeeId === actual.employeeId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Không thể tự override KPI của chính mình',
        HttpStatus.FORBIDDEN,
      );
    }
    const inScope = await this.periodScope.includesEmployeeTeam(
      scope,
      actual.payrollPeriodId,
      actual.employeeId,
      actual.teamId,
      null,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.employeeKpiActual.update({
        where: {
          id,
          leaderReviewStatus: { not: 'APPROVED' },
          ...(period.status === 'IN_REVIEW'
            ? { selfConfirmationStatus: 'CONFIRMED' as const }
            : {}),
        },
        data: {
          overrideValue: dto.overrideValue,
          overrideReason: dto.reason,
          overriddenByUserId: userId,
          overriddenAt: new Date(),
        },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'KPI_ACTUAL_OVERRIDE',
        entityType: 'EmployeeKpiActual',
        entityId: id,
        targetEmployeeId: actual.employeeId,
        payrollPeriodId: actual.payrollPeriodId,
        beforeData: { overrideValue: actual.overrideValue?.toNumber() ?? null },
        afterData: { overrideValue: dto.overrideValue },
        reason: dto.reason,
      });
      return updated;
    });
  }

  private async reviewGroup(
    userId: string,
    groupId: number,
    employeeId: number,
    periodId: number,
    decision: Extract<LeaderReviewStatus, 'APPROVED' | 'REJECTED'>,
    reason?: string,
    requestedTeamId?: number,
  ) {
    const period = await this.assertPeriodExists(periodId);
    this.assertPeriodEditable(period);
    assertPeriodInReview(
      period,
      decision === 'APPROVED' ? 'duyệt nhóm KPI' : 'từ chối nhóm KPI',
    );
    await this.assertGroupExists(groupId);
    await this.assertEmployeeExists(employeeId);

    const assignments = await this.prisma.employeeKpiAssignment.findMany({
      where: {
        employeeId,
        kpiGroupId: groupId,
        payrollPeriodId: periodId,
        assignmentStatus: 'ASSIGNED',
        teamId: requestedTeamId,
      },
    });
    if (assignments.length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự chưa được gán nhóm KPI này trong kỳ',
        HttpStatus.BAD_REQUEST,
      );
    }

    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'kpi.leader_approve',
    );
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
          ? 'KPI không nằm trong phạm vi team của bạn'
          : 'KPI tồn tại ở nhiều team; cần truyền teamId để duyệt đúng team',
        visibleAssignments.length === 0
          ? HttpStatus.FORBIDDEN
          : HttpStatus.BAD_REQUEST,
      );
    }
    const assignment = visibleAssignments[0];
    const actorEmployeeId = await this.authorization.getEmployeeId(userId);
    if (scope.type === 'TEAM' && actorEmployeeId === employeeId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Không thể tự duyệt KPI của chính mình',
        HttpStatus.FORBIDDEN,
      );
    }
    const inScope = await this.periodScope.includesEmployeeTeam(
      scope,
      periodId,
      employeeId,
      assignment.teamId,
      scope.type === 'SELF' ? actorEmployeeId : null,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    const actuals = await this.prisma.employeeKpiActual.findMany({
      where: {
        employeeId,
        teamId: assignment.teamId,
        payrollPeriodId: periodId,
        kpiItem: { kpiGroupId: groupId },
      },
    });
    if (actuals.length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Chưa có actual nào để duyệt',
        HttpStatus.BAD_REQUEST,
      );
    }
    const notConfirmed = actuals.some(
      (a) => a.selfConfirmationStatus !== 'CONFIRMED',
    );
    if (notConfirmed) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Còn đầu mục KPI trong nhóm chưa được nhân sự tự xác nhận',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (actuals.some((actual) => actual.leaderReviewStatus === 'APPROVED')) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhóm KPI đã được duyệt, không thể duyệt hoặc từ chối lại',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const ids = actuals.map((actual) => actual.id);
      const reviewedAt = new Date();
      const result = await tx.employeeKpiActual.updateMany({
        where: {
          id: { in: ids },
          selfConfirmationStatus: 'CONFIRMED',
          leaderReviewStatus: { not: 'APPROVED' },
        },
        data:
          decision === 'APPROVED'
            ? {
                leaderReviewStatus: 'APPROVED',
                leaderReviewedByUserId: userId,
                leaderReviewedAt: reviewedAt,
                leaderRejectionReason: null,
              }
            : {
                leaderReviewStatus: 'REJECTED',
                leaderReviewedByUserId: userId,
                leaderReviewedAt: reviewedAt,
                leaderRejectionReason: reason,
                selfConfirmationStatus: 'DRAFT',
                selfConfirmedByUserId: null,
                selfConfirmedAt: null,
                overrideValue: null,
                overrideReason: null,
              },
      });
      if (result.count !== actuals.length) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Dữ liệu KPI đã thay đổi bởi yêu cầu khác, vui lòng tải lại',
          HttpStatus.CONFLICT,
        );
      }

      await this.auditLog.recordMany(
        tx,
        actuals.map((actual) => ({
          actorUserId: userId,
          action:
            decision === 'APPROVED'
              ? 'KPI_ACTUAL_LEADER_APPROVED'
              : 'KPI_ACTUAL_LEADER_REJECTED',
          entityType: 'EmployeeKpiActual',
          entityId: actual.id,
          targetEmployeeId: employeeId,
          payrollPeriodId: periodId,
          reason: decision === 'REJECTED' ? reason : undefined,
        })),
      );
      return tx.employeeKpiActual.findMany({ where: { id: { in: ids } } });
    });
  }

  private async assertOwnActual(userId: string, actual: EmployeeKpiActual) {
    const selfEmployeeId = await this.authorization.getEmployeeId(userId);
    if (!selfEmployeeId || selfEmployeeId !== actual.employeeId) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Chỉ có thể thao tác trên actual KPI của chính mình',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertDraftEditable(actual: EmployeeKpiActual) {
    if (actual.selfConfirmationStatus !== 'DRAFT') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Actual đã xác nhận hoặc đã được duyệt, không thể sửa trực tiếp',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertClaimed(count: number) {
    if (count !== 1) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Dữ liệu KPI vừa được thay đổi bởi một yêu cầu khác, vui lòng tải lại',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async getActualOrThrow(id: number) {
    const actual = await this.prisma.employeeKpiActual.findUnique({
      where: { id },
    });
    if (!actual) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy actual KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    return actual;
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
        'Kỳ lương đã đóng, không thể thay đổi dữ liệu KPI',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertGroupExists(groupId: number) {
    const group = await this.prisma.kpiGroup.findUnique({
      where: { id: groupId },
    });
    if (!group) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhóm KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    return group;
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
}
