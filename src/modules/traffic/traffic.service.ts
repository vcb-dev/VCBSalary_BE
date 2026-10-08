import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type EmployeeTrafficRecord,
  type PayrollPeriodStatus,
  Prisma,
  type TrafficPlatform,
} from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginate, toSkipTake } from '../../common/utils/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../access-control/authorization.service';
import { PeriodScopeService } from '../access-control/period-scope.service';
import { AuditLogService } from '../audit/audit-log.service';
import { FilesService } from '../files/files.service';
import type {
  CustomTrafficDto,
  LeaderRejectTrafficDto,
  ListTrafficQueryDto,
  PutEmployeeTrafficDto,
} from './dto/traffic.dto';

/** Nền tảng luôn có ô nhập sẵn; nền tảng khác (OTHER) chỉ xuất hiện khi được thêm tay. */
const FIXED_PLATFORMS: TrafficPlatform[] = [
  'TIKTOK',
  'FACEBOOK',
  'YOUTUBE',
  'INSTAGRAM',
];
const FIXED_PLATFORM_NAMES = new Set(
  FIXED_PLATFORMS.map((platform) => platform.toLowerCase()),
);
const MAX_CUSTOM_PLATFORMS = 20;

type TrafficTarget = {
  periodId: number;
  employeeId: number;
  platform: TrafficPlatform;
  platformName: string;
};
type DraftRecord = EmployeeTrafficRecord & {
  attachments: { fileAttachmentId: string }[];
};

const trafficRecordInclude = {
  selfConfirmedBy: { select: { id: true, fullName: true } },
  leaderReviewedBy: { select: { id: true, fullName: true } },
  attachments: { select: { fileAttachmentId: true } },
} satisfies Prisma.EmployeeTrafficRecordInclude;

type TrafficRecordWithRelations = Prisma.EmployeeTrafficRecordGetPayload<{
  include: typeof trafficRecordInclude;
}>;
type AuthorizedFileResponse = Awaited<
  ReturnType<FilesService['getForAuthorizedAccess']>
>;

@Injectable()
export class TrafficService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditLog: AuditLogService,
    private readonly files: FilesService,
    private readonly periodScope: PeriodScopeService = new PeriodScopeService(
      prisma,
    ),
  ) {}

  /** Danh sách snapshot trong scope, dùng cho bộ chọn nhân sự và số liệu tổng quan trên FE. */
  async list(userId: string, periodId: number, query: ListTrafficQueryDto) {
    const scope = await this.authorization.resolveScope(userId, 'traffic');
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;
    const scopeWhere = this.periodScope.snapshotWhere(scope, selfEmployeeId);
    const filterWhere: Prisma.PayrollPeriodEmployeeSnapshotWhereInput = {
      teamIdSnapshot: query.teamId,
      OR: query.search
        ? [
            {
              employeeNameSnapshot: {
                contains: query.search,
                mode: 'insensitive',
              },
            },
            {
              employeeCodeSnapshot: {
                contains: query.search,
                mode: 'insensitive',
              },
            },
          ]
        : undefined,
    };
    const where: Prisma.PayrollPeriodEmployeeSnapshotWhereInput = {
      payrollPeriodId: periodId,
      AND: [scopeWhere, filterWhere],
    };
    const { skip, take } = toSkipTake(query.page, query.pageSize);

    // Kiểm tra kỳ chạy song song với truy vấn danh sách; kỳ không tồn tại vẫn trả 404 như cũ.
    const [, snapshots, total] = await Promise.all([
      this.assertPeriodExists(periodId),
      this.prisma.payrollPeriodEmployeeSnapshot.findMany({
        where,
        skip,
        take,
        orderBy: { employeeNameSnapshot: 'asc' },
        include: {
          employee: {
            select: {
              trafficRecords: {
                where: { payrollPeriodId: periodId },
                select: {
                  views: true,
                  selfConfirmationStatus: true,
                  leaderReviewStatus: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.payrollPeriodEmployeeSnapshot.count({ where }),
    ]);

    return paginate(
      snapshots.map((snapshot) => {
        const records = snapshot.employee.trafficRecords;
        return {
          employeeId: snapshot.employeeId,
          payrollPeriodId: snapshot.payrollPeriodId,
          employeeCode: snapshot.employeeCodeSnapshot,
          employeeName: snapshot.employeeNameSnapshot,
          jobTitle: snapshot.jobTitleSnapshot,
          teamId: snapshot.teamIdSnapshot,
          teamName: snapshot.teamNameSnapshot,
          totalViews: sumViews(records).toString(),
          acceptedViews: sumViews(records.filter(isAcceptedTraffic)).toString(),
          completedPlatforms: records.length,
          approvedPlatforms: records.filter(isAcceptedTraffic).length,
          pendingPlatforms: records.filter(
            (record) =>
              record.selfConfirmationStatus === 'CONFIRMED' &&
              record.leaderReviewStatus === 'PENDING',
          ).length,
          rejectedPlatforms: records.filter(
            (record) => record.leaderReviewStatus === 'REJECTED',
          ).length,
        };
      }),
      total,
      query.page,
      query.pageSize,
    );
  }

  async getForEmployee(userId: string, periodId: number, employeeId: number) {
    await this.assertPeriodExists(periodId);
    const snapshot = await this.getSnapshotOrThrow(periodId, employeeId);
    await this.assertVisible(userId, periodId, employeeId);
    const records = await this.prisma.employeeTrafficRecord.findMany({
      where: { employeeId, payrollPeriodId: periodId },
      include: trafficRecordInclude,
      orderBy: { id: 'asc' },
    });
    const attachmentIds = records.flatMap((record) =>
      record.attachments.map((attachment) => attachment.fileAttachmentId),
    );
    const attachments =
      await this.files.getManyForAuthorizedAccess(attachmentIds);
    const attachmentById = new Map(
      attachments.map((attachment) => [attachment.id, attachment]),
    );
    const fixedByPlatform = new Map(
      records
        .filter((record) => record.platform !== 'OTHER')
        .map((record) => [record.platform, record]),
    );
    // Nền tảng cố định trước (kể cả ô trống), nền tảng thêm tay sau theo thứ tự thêm.
    const platformRecords = await Promise.all([
      ...FIXED_PLATFORMS.map((platform) =>
        this.toRecordResponse(
          platform,
          fixedByPlatform.get(platform) ?? null,
          attachmentById,
        ),
      ),
      ...records
        .filter((record) => record.platform === 'OTHER')
        .map((record) =>
          this.toRecordResponse(record.platform, record, attachmentById),
        ),
    ]);

    return {
      employeeId,
      payrollPeriodId: periodId,
      employeeCode: snapshot.employeeCodeSnapshot,
      employeeName: snapshot.employeeNameSnapshot,
      jobTitle: snapshot.jobTitleSnapshot,
      teamId: snapshot.teamIdSnapshot,
      teamName: snapshot.teamNameSnapshot,
      totalViews: sumViews(records).toString(),
      acceptedViews: sumViews(records.filter(isAcceptedTraffic)).toString(),
      records: platformRecords,
    };
  }

  /** Upsert idempotent nền tảng cố định theo UNIQUE(employee, period, platform), chỉ khi còn draft. */
  async upsert(
    actorUserId: string,
    periodId: number,
    employeeId: number,
    platform: TrafficPlatform,
    dto: PutEmployeeTrafficDto,
  ) {
    if (platform === 'OTHER') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nền tảng khác cần có tên, hãy dùng chức năng thêm nền tảng khác',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.assertWritableEmployee(actorUserId, periodId, employeeId);

    const existing = await this.prisma.employeeTrafficRecord.findUnique({
      where: {
        employeeId_payrollPeriodId_platform_platformName: {
          employeeId,
          payrollPeriodId: periodId,
          platform,
          platformName: '',
        },
      },
      include: { attachments: { select: { fileAttachmentId: true } } },
    });
    if (existing) this.assertDraftEditable(existing);
    return this.saveDraft(
      actorUserId,
      { periodId, employeeId, platform, platformName: '' },
      existing,
      dto,
    );
  }

  /** Thêm traffic của một nền tảng ngoài danh sách cố định, tên do người nhập tự đặt. */
  async createCustom(
    actorUserId: string,
    periodId: number,
    employeeId: number,
    dto: CustomTrafficDto,
  ) {
    await this.assertWritableEmployee(actorUserId, periodId, employeeId);
    const siblings = await this.findCustomSiblings(periodId, employeeId);
    this.assertCustomPlatformName(dto.platformName, siblings);
    if (siblings.length >= MAX_CUSTOM_PLATFORMS) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Mỗi nhân sự chỉ thêm được tối đa ${MAX_CUSTOM_PLATFORMS} nền tảng khác trong một kỳ`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.saveDraft(
      actorUserId,
      {
        periodId,
        employeeId,
        platform: 'OTHER',
        platformName: dto.platformName,
      },
      null,
      dto,
    );
  }

  /** Sửa tên, lượt xem, minh chứng của nền tảng thêm tay khi bản ghi còn nháp. */
  async updateCustom(actorUserId: string, id: number, dto: CustomTrafficDto) {
    const record = await this.getCustomRecordOrThrow(id);
    await this.assertWritableEmployee(
      actorUserId,
      record.payrollPeriodId,
      record.employeeId,
    );
    this.assertDraftEditable(record);
    const siblings = await this.findCustomSiblings(
      record.payrollPeriodId,
      record.employeeId,
      id,
    );
    this.assertCustomPlatformName(dto.platformName, siblings);
    return this.saveDraft(
      actorUserId,
      {
        periodId: record.payrollPeriodId,
        employeeId: record.employeeId,
        platform: 'OTHER',
        platformName: dto.platformName,
      },
      record,
      dto,
    );
  }

  /** Xoá nền tảng thêm nhầm; đã tự xác nhận hoặc đã duyệt thì không xoá được. */
  async deleteCustom(actorUserId: string, id: number) {
    const record = await this.getCustomRecordOrThrow(id);
    await this.assertWritableEmployee(
      actorUserId,
      record.payrollPeriodId,
      record.employeeId,
    );
    this.assertDraftEditable(record);

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.employeeTrafficRecord.deleteMany({
        where: {
          id,
          selfConfirmationStatus: 'DRAFT',
          leaderReviewStatus: { not: 'APPROVED' },
        },
      });
      this.assertClaimed(deleted.count);
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'TRAFFIC_DELETED',
        entityType: 'EmployeeTrafficRecord',
        entityId: String(id),
        targetEmployeeId: record.employeeId,
        payrollPeriodId: record.payrollPeriodId,
        beforeData: {
          platform: record.platform,
          platformName: record.platformName,
          views: record.views.toString(),
          attachmentIds: record.attachments.map(
            (attachment) => attachment.fileAttachmentId,
          ),
        },
      });
    });
    return { id, deleted: true };
  }

  private async saveDraft(
    actorUserId: string,
    target: TrafficTarget,
    existing: DraftRecord | null,
    dto: PutEmployeeTrafficDto,
  ) {
    const { periodId, employeeId, platform, platformName } = target;
    if (dto.attachmentIds) {
      const retainedIds = new Set(
        existing?.attachments.map(
          (attachment) => attachment.fileAttachmentId,
        ) ?? [],
      );
      await this.assertOwnedAttachments(
        actorUserId,
        dto.attachmentIds.filter((id) => !retainedIds.has(id)),
      );
    }

    const views = BigInt(dto.views);
    const record = await this.prisma.$transaction(async (tx) => {
      let saved: EmployeeTrafficRecord;
      if (existing) {
        const claimed = await tx.employeeTrafficRecord.updateMany({
          where: {
            id: existing.id,
            selfConfirmationStatus: 'DRAFT',
            leaderReviewStatus: { not: 'APPROVED' },
          },
          data: { views, platformName },
        });
        this.assertClaimed(claimed.count);
        saved = await tx.employeeTrafficRecord.findUniqueOrThrow({
          where: { id: existing.id },
        });
      } else {
        saved = await tx.employeeTrafficRecord.create({
          data: {
            employeeId,
            payrollPeriodId: periodId,
            platform,
            platformName,
            views,
          },
        });
      }

      if (dto.attachmentIds) {
        await tx.trafficRecordAttachment.deleteMany({
          where: { employeeTrafficRecordId: saved.id },
        });
        if (dto.attachmentIds.length > 0) {
          await tx.trafficRecordAttachment.createMany({
            data: dto.attachmentIds.map((fileAttachmentId) => ({
              employeeTrafficRecordId: saved.id,
              fileAttachmentId,
            })),
          });
        }
      }

      await this.auditLog.record(tx, {
        actorUserId,
        action: existing ? 'TRAFFIC_UPDATED' : 'TRAFFIC_CREATED',
        entityType: 'EmployeeTrafficRecord',
        entityId: String(saved.id),
        targetEmployeeId: employeeId,
        payrollPeriodId: periodId,
        beforeData: existing
          ? {
              ...(platform === 'OTHER'
                ? { platformName: existing.platformName }
                : {}),
              views: existing.views.toString(),
              attachmentIds: existing.attachments.map(
                (attachment) => attachment.fileAttachmentId,
              ),
            }
          : undefined,
        afterData: {
          platform,
          ...(platform === 'OTHER' ? { platformName } : {}),
          views: dto.views,
          attachmentIds:
            dto.attachmentIds ??
            existing?.attachments.map(
              (attachment) => attachment.fileAttachmentId,
            ) ??
            [],
        },
      });

      return tx.employeeTrafficRecord.findUniqueOrThrow({
        where: { id: saved.id },
        include: trafficRecordInclude,
      });
    });

    return this.toRecordResponse(platform, record);
  }

  async selfConfirm(actorUserId: string, id: number) {
    const record = await this.getRecordOrThrow(id);
    const period = await this.assertPeriodExists(record.payrollPeriodId);
    this.assertPeriodEditable(period);
    const actorEmployeeId = await this.authorization.getEmployeeId(actorUserId);
    if (!actorEmployeeId || actorEmployeeId !== record.employeeId) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Chỉ có thể tự xác nhận traffic của chính mình',
        HttpStatus.FORBIDDEN,
      );
    }
    this.assertDraftEditable(record);

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeTrafficRecord.updateMany({
        where: {
          id,
          selfConfirmationStatus: 'DRAFT',
          leaderReviewStatus: { not: 'APPROVED' },
        },
        data: {
          selfConfirmationStatus: 'CONFIRMED',
          selfConfirmedByUserId: actorUserId,
          selfConfirmedAt: new Date(),
          leaderReviewStatus: 'PENDING',
          leaderRejectionReason: null,
        },
      });
      this.assertClaimed(claimed.count);
      const saved = await tx.employeeTrafficRecord.findUniqueOrThrow({
        where: { id },
        include: trafficRecordInclude,
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'TRAFFIC_SELF_CONFIRMED',
        entityType: 'EmployeeTrafficRecord',
        entityId: String(id),
        targetEmployeeId: record.employeeId,
        payrollPeriodId: record.payrollPeriodId,
      });
      return saved;
    });
    return this.toRecordResponse(record.platform, updated);
  }

  async leaderApprove(actorUserId: string, id: number) {
    return this.review(actorUserId, id, 'APPROVED');
  }

  async leaderReject(
    actorUserId: string,
    id: number,
    dto: LeaderRejectTrafficDto,
  ) {
    return this.review(actorUserId, id, 'REJECTED', dto.reason.trim());
  }

  private async review(
    actorUserId: string,
    id: number,
    decision: 'APPROVED' | 'REJECTED',
    reason?: string,
  ) {
    const record = await this.getRecordOrThrow(id);
    const period = await this.assertPeriodExists(record.payrollPeriodId);
    this.assertPeriodEditable(period);
    await this.assertCanReview(actorUserId, record);

    if (record.selfConfirmationStatus !== 'CONFIRMED') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Traffic chưa được nhân sự tự xác nhận',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (record.leaderReviewStatus === 'APPROVED') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Traffic đã được duyệt, không thể duyệt hoặc từ chối lại',
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.employeeTrafficRecord.updateMany({
        where: {
          id,
          selfConfirmationStatus: 'CONFIRMED',
          leaderReviewStatus: 'PENDING',
        },
        data:
          decision === 'APPROVED'
            ? {
                leaderReviewStatus: 'APPROVED',
                leaderReviewedByUserId: actorUserId,
                leaderReviewedAt: new Date(),
                leaderRejectionReason: null,
              }
            : {
                leaderReviewStatus: 'REJECTED',
                leaderReviewedByUserId: actorUserId,
                leaderReviewedAt: new Date(),
                leaderRejectionReason: reason,
                selfConfirmationStatus: 'DRAFT',
                selfConfirmedByUserId: null,
                selfConfirmedAt: null,
              },
      });
      this.assertClaimed(claimed.count);
      const saved = await tx.employeeTrafficRecord.findUniqueOrThrow({
        where: { id },
        include: trafficRecordInclude,
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action:
          decision === 'APPROVED'
            ? 'TRAFFIC_LEADER_APPROVED'
            : 'TRAFFIC_LEADER_REJECTED',
        entityType: 'EmployeeTrafficRecord',
        entityId: String(id),
        targetEmployeeId: record.employeeId,
        payrollPeriodId: record.payrollPeriodId,
        reason: decision === 'REJECTED' ? reason : undefined,
      });
      return saved;
    });
    return this.toRecordResponse(record.platform, updated);
  }

  private async assertVisible(
    userId: string,
    periodId: number,
    employeeId: number,
  ) {
    const scope = await this.authorization.resolveScope(userId, 'traffic');
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
        'Nhân sự này không nằm trong phạm vi dữ liệu traffic của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertCanWrite(
    userId: string,
    periodId: number,
    employeeId: number,
  ) {
    const [permissions, actorEmployeeId, teamWriteScope] = await Promise.all([
      this.authorization.getPermissionCodes(userId),
      this.authorization.getEmployeeId(userId),
      this.authorization.resolvePermissionScope(userId, 'traffic.write_team'),
    ]);
    if (
      permissions.has('traffic.write_self') &&
      actorEmployeeId === employeeId
    ) {
      return;
    }
    if (permissions.has('traffic.write_team')) {
      const inScope = await this.periodScope.includesEmployee(
        teamWriteScope,
        periodId,
        employeeId,
        teamWriteScope.type === 'SELF' ? actorEmployeeId : null,
      );
      if (inScope) return;
    }
    throw new AppException(
      ErrorCode.OUT_OF_SCOPE,
      'Bạn không được nhập traffic cho nhân sự này',
      HttpStatus.FORBIDDEN,
    );
  }

  private async assertCanReview(userId: string, record: EmployeeTrafficRecord) {
    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'traffic.leader_approve',
    );
    const actorEmployeeId = await this.authorization.getEmployeeId(userId);
    if (scope.type === 'TEAM' && actorEmployeeId === record.employeeId) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Không thể tự duyệt traffic của chính mình',
        HttpStatus.FORBIDDEN,
      );
    }
    const inScope = await this.periodScope.includesEmployee(
      scope,
      record.payrollPeriodId,
      record.employeeId,
      scope.type === 'SELF' ? actorEmployeeId : null,
    );
    if (!inScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi duyệt traffic của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertOwnedAttachments(userId: string, ids: string[]) {
    if (ids.length === 0) return;
    const attachments = await this.prisma.fileAttachment.findMany({
      where: { id: { in: ids }, uploadedByUserId: userId },
      select: { id: true },
    });
    if (attachments.length !== ids.length) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Có file minh chứng không tồn tại hoặc không do bạn tải lên',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertDraftEditable(record: EmployeeTrafficRecord) {
    if (
      record.selfConfirmationStatus !== 'DRAFT' ||
      record.leaderReviewStatus === 'APPROVED'
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Traffic đã xác nhận hoặc đã được duyệt, không thể sửa trực tiếp',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertClaimed(count: number) {
    if (count !== 1) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Bản ghi traffic vừa được thay đổi bởi một yêu cầu khác',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async assertWritableEmployee(
    actorUserId: string,
    periodId: number,
    employeeId: number,
  ) {
    const period = await this.assertPeriodExists(periodId);
    this.assertPeriodEditable(period);
    await this.getSnapshotOrThrow(periodId, employeeId);
    await this.assertCanWrite(actorUserId, periodId, employeeId);
  }

  private findCustomSiblings(
    periodId: number,
    employeeId: number,
    excludeId?: number,
  ) {
    return this.prisma.employeeTrafficRecord.findMany({
      where: {
        employeeId,
        payrollPeriodId: periodId,
        platform: 'OTHER',
        id: excludeId ? { not: excludeId } : undefined,
      },
      select: { platformName: true },
    });
  }

  /** Unique của DB phân biệt hoa/thường; "threads" và "Threads" vẫn phải là một nền tảng. */
  private assertCustomPlatformName(
    platformName: string,
    siblings: { platformName: string }[],
  ) {
    const key = platformName.toLowerCase();
    if (FIXED_PLATFORM_NAMES.has(key)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `${platformName} đã có ô nhập sẵn, hãy nhập ở thẻ nền tảng đó`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (
      siblings.some((sibling) => sibling.platformName.toLowerCase() === key)
    ) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `Nhân sự đã có traffic nền tảng "${platformName}" trong kỳ này`,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async getCustomRecordOrThrow(id: number) {
    const record = await this.prisma.employeeTrafficRecord.findUnique({
      where: { id },
      include: { attachments: { select: { fileAttachmentId: true } } },
    });
    if (!record) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy bản ghi traffic',
        HttpStatus.NOT_FOUND,
      );
    }
    if (record.platform !== 'OTHER') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Chỉ đổi tên hoặc xoá được nền tảng thêm tay',
        HttpStatus.BAD_REQUEST,
      );
    }
    return record;
  }

  private async getRecordOrThrow(id: number) {
    const record = await this.prisma.employeeTrafficRecord.findUnique({
      where: { id },
    });
    if (!record) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy bản ghi traffic',
        HttpStatus.NOT_FOUND,
      );
    }
    return record;
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
        'Kỳ lương đã đóng, không thể thay đổi traffic',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async getSnapshotOrThrow(periodId: number, employeeId: number) {
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
    return snapshot;
  }

  private async toRecordResponse(
    platform: TrafficPlatform,
    record: TrafficRecordWithRelations | null,
    attachmentById?: ReadonlyMap<string, AuthorizedFileResponse>,
  ) {
    if (!record) {
      return {
        id: null,
        platform,
        platformName: null,
        views: '0',
        selfConfirmationStatus: 'DRAFT' as const,
        selfConfirmedBy: null,
        selfConfirmedAt: null,
        leaderReviewStatus: 'PENDING' as const,
        leaderReviewedBy: null,
        leaderReviewedAt: null,
        leaderRejectionReason: null,
        attachments: [],
        createdAt: null,
        updatedAt: null,
      };
    }

    const attachments = attachmentById
      ? record.attachments.map((attachment) =>
          attachmentById.get(attachment.fileAttachmentId)!,
        )
      : await this.files.getManyForAuthorizedAccess(
          record.attachments.map((attachment) => attachment.fileAttachmentId),
        );
    return {
      id: record.id,
      platform: record.platform,
      platformName: record.platform === 'OTHER' ? record.platformName : null,
      views: record.views.toString(),
      selfConfirmationStatus: record.selfConfirmationStatus,
      selfConfirmedBy: record.selfConfirmedBy,
      selfConfirmedAt: record.selfConfirmedAt,
      leaderReviewStatus: record.leaderReviewStatus,
      leaderReviewedBy: record.leaderReviewedBy,
      leaderReviewedAt: record.leaderReviewedAt,
      leaderRejectionReason: record.leaderRejectionReason,
      attachments,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

function isAcceptedTraffic(record: {
  selfConfirmationStatus: string;
  leaderReviewStatus: string;
}) {
  return (
    record.selfConfirmationStatus === 'CONFIRMED' &&
    record.leaderReviewStatus === 'APPROVED'
  );
}

function sumViews(records: Array<{ views: bigint }>) {
  return records.reduce((total, record) => total + record.views, 0n);
}
