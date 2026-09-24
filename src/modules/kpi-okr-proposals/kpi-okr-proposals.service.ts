import { HttpStatus, Injectable } from '@nestjs/common';
import type { KpiOkrProposal, Prisma } from '@prisma/client';
import { AuditLogService } from '../audit/audit-log.service';
import { AuthorizationService } from '../access-control/authorization.service';
import { PeriodScopeService } from '../access-control/period-scope.service';
import type { ResolvedScope } from '../../common/types/resolved-scope.types';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CreateKpiOkrProposalDto,
  RejectProposalDto,
} from './dto/kpi-okr-proposal.dto';

@Injectable()
export class KpiOkrProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditLog: AuditLogService,
    private readonly periodScope: PeriodScopeService = new PeriodScopeService(
      prisma,
    ),
  ) {}

  /**
   * Không có permission `proposal.view_*` riêng trong catalog — scope theo đúng resource của
   * `proposalType` (OKR dùng scope 'okr', KPI_ITEM dùng scope 'kpi'), cộng thêm luôn thấy đề xuất
   * do chính mình gửi (để Editor/Content Creator theo dõi đề xuất của họ dù chỉ có scope SELF).
   */
  async list(userId: string) {
    const proposals = await this.prisma.kpiOkrProposal.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        proposedKpiGroup: { select: { id: true, code: true, name: true } },
        proposerEmployee: {
          select: { id: true, employeeCode: true, fullName: true },
        },
      },
    });

    const [selfEmployeeId, kpiScope, okrScope] = await Promise.all([
      this.authorization.getEmployeeId(userId),
      this.authorization.resolveScope(userId, 'kpi'),
      this.authorization.resolveScope(userId, 'okr'),
    ]);

    // TEAM scope trước đây gọi findUnique snapshot cho từng proposal (N+1). Nạp một lần các
    // snapshot liên quan rồi kiểm tra bằng Set trong bộ nhớ.
    const snapshotFilters = [
      this.teamSnapshotFilter(proposals, 'KPI_ITEM', kpiScope),
      this.teamSnapshotFilter(proposals, 'OKR', okrScope),
    ].filter((filter): filter is NonNullable<typeof filter> => filter != null);
    const snapshots =
      snapshotFilters.length > 0
        ? await this.prisma.payrollPeriodEmployeeSnapshot.findMany({
            where: { OR: snapshotFilters },
            select: {
              payrollPeriodId: true,
              employeeId: true,
              teamIdSnapshot: true,
            },
          })
        : [];
    const teamBySnapshotKey = new Map(
      snapshots.map((snapshot) => [
        `${snapshot.payrollPeriodId}:${snapshot.employeeId}`,
        snapshot.teamIdSnapshot,
      ]),
    );

    return proposals.filter((proposal) => {
      if (
        selfEmployeeId != null &&
        proposal.proposerEmployeeId === selfEmployeeId
      ) {
        return true;
      }
      const scope = proposal.proposalType === 'OKR' ? okrScope : kpiScope;
      if (scope.type === 'ALL') return true;
      if (scope.type !== 'TEAM') return false;
      const teamId = teamBySnapshotKey.get(
        `${proposal.payrollPeriodId}:${proposal.proposerEmployeeId}`,
      );
      return teamId != null && scope.teamIds.includes(teamId);
    });
  }

  async getOne(userId: string, id: number) {
    const proposal = await this.getOrThrow(id);
    const selfEmployeeId = await this.authorization.getEmployeeId(userId);
    const scope = await this.authorization.resolveScope(
      userId,
      proposal.proposalType === 'OKR' ? 'okr' : 'kpi',
    );
    const visible = await this.isVisible(proposal, selfEmployeeId, scope);
    if (!visible) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Đề xuất này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
    return proposal;
  }

  async create(userId: string, dto: CreateKpiOkrProposalDto) {
    const period = await this.assertPeriodExists(dto.payrollPeriodId);
    this.assertPeriodEditable(period);

    const proposerEmployeeId = await this.authorization.getEmployeeId(userId);
    if (!proposerEmployeeId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Tài khoản của bạn chưa gắn với hồ sơ nhân sự, không thể gửi đề xuất',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.assertSnapshotExists(dto.payrollPeriodId, proposerEmployeeId);

    if (dto.proposalType === 'KPI_ITEM') {
      if (!dto.proposedKpiGroupId) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Đề xuất loại KPI_ITEM cần chọn nhóm KPI (proposedKpiGroupId)',
          HttpStatus.BAD_REQUEST,
        );
      }
      const group = await this.prisma.kpiGroup.findUnique({
        where: { id: dto.proposedKpiGroupId },
      });
      if (!group) {
        throw new AppException(
          ErrorCode.NOT_FOUND,
          'Không tìm thấy nhóm KPI',
          HttpStatus.NOT_FOUND,
        );
      }
    } else {
      if (dto.proposedKpiGroupId) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Đề xuất loại OKR không dùng proposedKpiGroupId',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (dto.proposedRewardAmount == null) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Đề xuất loại OKR cần proposedRewardAmount (bắt buộc để tự tạo OKR khi được duyệt)',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const proposal = await tx.kpiOkrProposal.create({
        data: {
          payrollPeriodId: dto.payrollPeriodId,
          proposerEmployeeId,
          proposalType: dto.proposalType,
          proposedKpiGroupId: dto.proposedKpiGroupId,
          proposedName: dto.proposedName,
          proposedUnit: dto.proposedUnit,
          proposedTargetValue: dto.proposedTargetValue,
          proposedRewardAmount: dto.proposedRewardAmount,
          proposedDeadline: dto.proposedDeadline
            ? new Date(dto.proposedDeadline)
            : undefined,
          reason: dto.reason,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'PROPOSAL_CREATED',
        entityType: 'KpiOkrProposal',
        entityId: proposal.id,
        targetEmployeeId: proposerEmployeeId,
        payrollPeriodId: dto.payrollPeriodId,
        afterData: {
          proposalType: dto.proposalType,
          proposedName: dto.proposedName,
        },
      });
      return proposal;
    });
  }

  /**
   * Approve OKR: tự tạo EmployeeOkr đầy đủ field (đã validate bắt buộc proposedRewardAmount lúc
   * tạo proposal). Approve KPI_ITEM: chỉ chuyển status — xem ghi chú ở model KpiOkrProposal.
   * Idempotent: chặn approve/reject lần 2 bằng kiểm tra status !== PENDING (double click không
   * tạo trùng OKR).
   */
  async approve(userId: string, id: number) {
    const proposal = await this.getOrThrow(id);
    await this.assertReviewable(userId, proposal);
    const period = await this.assertPeriodExists(proposal.payrollPeriodId);
    this.assertPeriodEditable(period);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.kpiOkrProposal.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'APPROVED' },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Đề xuất đã được xử lý bởi yêu cầu khác',
          HttpStatus.CONFLICT,
        );
      }

      let resultEntityType: string | null = null;
      let resultEntityId: number | null = null;

      if (proposal.proposalType === 'OKR') {
        const okr = await tx.employeeOkr.create({
          data: {
            employeeId: proposal.proposerEmployeeId,
            payrollPeriodId: proposal.payrollPeriodId,
            title: proposal.proposedName,
            unit: proposal.proposedUnit,
            targetValue: proposal.proposedTargetValue,
            // Bắt buộc non-null khi tạo proposal loại OKR — đã validate ở create().
            rewardAmount: proposal.proposedRewardAmount!,
            deadline: proposal.proposedDeadline,
          },
        });
        resultEntityType = 'EmployeeOkr';
        resultEntityId = okr.id;
        await this.auditLog.record(tx, {
          actorUserId: userId,
          action: 'OKR_CREATED',
          entityType: 'EmployeeOkr',
          entityId: okr.id,
          targetEmployeeId: proposal.proposerEmployeeId,
          payrollPeriodId: proposal.payrollPeriodId,
          reason: 'Tạo từ đề xuất đã duyệt',
          afterData: { proposalId: proposal.id },
        });
      }

      const updated = await tx.kpiOkrProposal.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedByUserId: userId,
          reviewedAt: new Date(),
          resultEntityType,
          resultEntityId,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'PROPOSAL_APPROVED',
        entityType: 'KpiOkrProposal',
        entityId: id,
        targetEmployeeId: proposal.proposerEmployeeId,
        payrollPeriodId: proposal.payrollPeriodId,
      });
      return updated;
    });
  }

  async reject(userId: string, id: number, dto: RejectProposalDto) {
    const proposal = await this.getOrThrow(id);
    await this.assertReviewable(userId, proposal);
    const period = await this.assertPeriodExists(proposal.payrollPeriodId);
    this.assertPeriodEditable(period);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.kpiOkrProposal.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'REJECTED' },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Đề xuất đã được xử lý bởi yêu cầu khác',
          HttpStatus.CONFLICT,
        );
      }

      const updated = await tx.kpiOkrProposal.update({
        where: { id },
        data: {
          status: 'REJECTED',
          reviewedByUserId: userId,
          reviewedAt: new Date(),
          rejectionReason: dto.reason,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId: userId,
        action: 'PROPOSAL_REJECTED',
        entityType: 'KpiOkrProposal',
        entityId: id,
        targetEmployeeId: proposal.proposerEmployeeId,
        payrollPeriodId: proposal.payrollPeriodId,
        reason: dto.reason,
      });
      return updated;
    });
  }

  private async isVisible(
    proposal: KpiOkrProposal,
    selfEmployeeId: number | null,
    scope: ResolvedScope,
  ) {
    if (selfEmployeeId && proposal.proposerEmployeeId === selfEmployeeId)
      return true;
    return this.periodScope.includesEmployee(
      scope,
      proposal.payrollPeriodId,
      proposal.proposerEmployeeId,
      scope.type === 'SELF' ? selfEmployeeId : null,
    );
  }

  private teamSnapshotFilter(
    proposals: KpiOkrProposal[],
    proposalType: KpiOkrProposal['proposalType'],
    scope: ResolvedScope,
  ): Prisma.PayrollPeriodEmployeeSnapshotWhereInput | null {
    if (scope.type !== 'TEAM' || scope.teamIds.length === 0) return null;
    const payrollPeriodIds = [
      ...new Set(
        proposals
          .filter((proposal) => proposal.proposalType === proposalType)
          .map((proposal) => proposal.payrollPeriodId),
      ),
    ];
    if (payrollPeriodIds.length === 0) return null;
    return {
      payrollPeriodId: { in: payrollPeriodIds },
      teamIdSnapshot: { in: scope.teamIds },
    };
  }

  private async assertReviewable(userId: string, proposal: KpiOkrProposal) {
    if (proposal.status !== 'PENDING') {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Đề xuất đã được xử lý trước đó',
        HttpStatus.CONFLICT,
      );
    }
    const scope = await this.authorization.resolvePermissionScope(
      userId,
      proposal.proposalType === 'OKR'
        ? 'okr.leader_approve'
        : 'kpi.leader_approve',
    );
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;
    const inScope = await this.periodScope.includesEmployee(
      scope,
      proposal.payrollPeriodId,
      proposal.proposerEmployeeId,
      selfEmployeeId,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Đề xuất này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async getOrThrow(id: number) {
    const proposal = await this.prisma.kpiOkrProposal.findUnique({
      where: { id },
      include: {
        proposedKpiGroup: { select: { id: true, code: true, name: true } },
        proposerEmployee: {
          select: { id: true, employeeCode: true, fullName: true },
        },
      },
    });
    if (!proposal) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy đề xuất',
        HttpStatus.NOT_FOUND,
      );
    }
    return proposal;
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

  private assertPeriodEditable(period: { status: string }) {
    if (period.status === 'CLOSED') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Kỳ lương đã đóng, không thể thay đổi đề xuất',
        HttpStatus.BAD_REQUEST,
      );
    }
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
