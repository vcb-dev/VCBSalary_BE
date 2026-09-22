import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, RewardRuleSetStatus } from '@prisma/client';
import { AuditLogService } from '../../audit/audit-log.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  CreateRevenueRewardBracketDto,
  UpdateRevenueRewardBracketDto,
} from './dto/revenue-reward-bracket.dto';
import type { CreateRewardRuleSetDto } from './dto/reward-rule-set.dto';

@Injectable()
export class RewardRuleSetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  list() {
    return this.prisma.rewardRuleSet.findMany({ orderBy: { version: 'desc' } });
  }

  async getOrThrow(id: number) {
    const ruleSet = await this.prisma.rewardRuleSet.findUnique({
      where: { id },
    });
    if (!ruleSet) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy bộ cấu hình mốc thưởng',
        HttpStatus.NOT_FOUND,
      );
    }
    return ruleSet;
  }

  async create(dto: CreateRewardRuleSetDto, actorUserId: string) {
    if (dto.effectiveFromPeriodId) {
      await this.assertPeriodExists(dto.effectiveFromPeriodId);
    }

    return this.runSerializable(async (tx) => {
      // Đọc nguồn clone và version trong cùng transaction để hai request tạo đồng thời không cùng
      // nhận một version hoặc clone nửa chừng khi brackets đang được chỉnh sửa.
      const sourceBrackets = dto.cloneRevenueBracketsFromRuleSetId
        ? await tx.revenueRewardBracket.findMany({
            where: { rewardRuleSetId: dto.cloneRevenueBracketsFromRuleSetId },
            orderBy: { sortOrder: 'asc' },
          })
        : [];
      const latest = await tx.rewardRuleSet.findFirst({
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const ruleSet = await tx.rewardRuleSet.create({
        data: {
          version: (latest?.version ?? 0) + 1,
          achievementThresholdPercent: dto.achievementThresholdPercent,
          effectiveFromPeriodId: dto.effectiveFromPeriodId,
          createdByUserId: actorUserId,
        },
      });

      if (sourceBrackets.length > 0) {
        await tx.revenueRewardBracket.createMany({
          data: sourceBrackets.map((bracket) => ({
            rewardRuleSetId: ruleSet.id,
            label: bracket.label,
            minRevenueAmount: bracket.minRevenueAmount,
            maxRevenueAmount: bracket.maxRevenueAmount,
            commissionRatePercent: bracket.commissionRatePercent,
            rpmRatePer1000Views: bracket.rpmRatePer1000Views,
            sortOrder: bracket.sortOrder,
          })),
        });
      }

      await this.auditLog.record(tx, {
        actorUserId,
        action: 'REWARD_RULE_SET_CREATED',
        entityType: 'RewardRuleSet',
        entityId: ruleSet.id,
        afterData: {
          version: ruleSet.version,
          achievementThresholdPercent: dto.achievementThresholdPercent,
          clonedFrom: dto.cloneRevenueBracketsFromRuleSetId ?? null,
          clonedBracketCount: sourceBrackets.length,
        },
      });

      return ruleSet;
    });
  }

  async activate(id: number, actorUserId: string) {
    const ruleSet = await this.getOrThrow(id);
    if (ruleSet.status !== RewardRuleSetStatus.DRAFT) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Chỉ có thể activate bộ cấu hình đang ở trạng thái DRAFT',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.runSerializable(async (tx) => {
      // Claim parent trước khi đọc brackets. Mọi thao tác thêm/sửa/xóa bracket cũng khóa cùng
      // row này, nên activation không thể chạy xen giữa lúc validate và lúc chuyển ACTIVE.
      const claimed = await tx.rewardRuleSet.updateMany({
        where: { id, status: RewardRuleSetStatus.DRAFT },
        data: { status: RewardRuleSetStatus.ACTIVE },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Bộ cấu hình vừa được thay đổi bởi một yêu cầu khác',
          HttpStatus.CONFLICT,
        );
      }
      const brackets = await tx.revenueRewardBracket.findMany({
        where: { rewardRuleSetId: id },
        orderBy: { minRevenueAmount: 'asc' },
      });
      this.assertCompleteBracketCoverage(brackets);

      const previousActive = await tx.rewardRuleSet.findFirst({
        where: {
          status: RewardRuleSetStatus.ACTIVE,
          id: { not: id },
        },
      });

      if (previousActive) {
        await tx.rewardRuleSet.update({
          where: { id: previousActive.id },
          data: { status: RewardRuleSetStatus.ARCHIVED },
        });
      }

      const updated = await tx.rewardRuleSet.findUniqueOrThrow({
        where: { id },
      });

      await this.auditLog.record(tx, {
        actorUserId,
        action: 'REWARD_RULE_SET_ACTIVATED',
        entityType: 'RewardRuleSet',
        entityId: id,
        beforeData: { status: ruleSet.status },
        afterData: {
          status: RewardRuleSetStatus.ACTIVE,
          archivedRuleSetId: previousActive?.id ?? null,
        },
      });

      return updated;
    });
  }

  async archive(id: number, actorUserId: string) {
    const ruleSet = await this.getOrThrow(id);
    if (ruleSet.status === RewardRuleSetStatus.ARCHIVED) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Bộ cấu hình đã ở trạng thái ARCHIVED',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.rewardRuleSet.updateMany({
        where: { id, status: ruleSet.status },
        data: { status: RewardRuleSetStatus.ARCHIVED },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Bộ cấu hình vừa được thay đổi bởi một yêu cầu khác',
          HttpStatus.CONFLICT,
        );
      }
      const updated = await tx.rewardRuleSet.findUniqueOrThrow({
        where: { id },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'REWARD_RULE_SET_ARCHIVED',
        entityType: 'RewardRuleSet',
        entityId: id,
        beforeData: { status: ruleSet.status },
        afterData: { status: RewardRuleSetStatus.ARCHIVED },
      });
      return updated;
    });
  }

  async listBrackets(ruleSetId: number) {
    await this.getOrThrow(ruleSetId);
    return this.prisma.revenueRewardBracket.findMany({
      where: { rewardRuleSetId: ruleSetId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createBracket(
    ruleSetId: number,
    dto: CreateRevenueRewardBracketDto,
    actorUserId: string,
  ) {
    const ruleSet = await this.getOrThrow(ruleSetId);
    this.assertDraft(ruleSet.status);
    this.assertBracketRangeValid(dto.minRevenueAmount, dto.maxRevenueAmount);
    this.assertCommissionRateValid(dto.commissionRatePercent);

    return this.runSerializable(async (tx) => {
      await this.claimDraftRuleSet(tx, ruleSetId);
      const siblings = await tx.revenueRewardBracket.findMany({
        where: { rewardRuleSetId: ruleSetId },
      });
      this.assertNoOverlap(
        siblings,
        dto.minRevenueAmount,
        dto.maxRevenueAmount,
      );
      const bracket = await tx.revenueRewardBracket.create({
        data: {
          rewardRuleSetId: ruleSetId,
          label: dto.label,
          minRevenueAmount: dto.minRevenueAmount,
          maxRevenueAmount: dto.maxRevenueAmount,
          commissionRatePercent: dto.commissionRatePercent,
          rpmRatePer1000Views: dto.rpmRatePer1000Views,
          sortOrder:
            siblings.reduce(
              (highest, sibling) => Math.max(highest, sibling.sortOrder),
              -1,
            ) + 1,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'REVENUE_REWARD_BRACKET_CREATED',
        entityType: 'RevenueRewardBracket',
        entityId: bracket.id,
        afterData: {
          rewardRuleSetId: ruleSetId,
          label: dto.label,
          minRevenueAmount: dto.minRevenueAmount,
          maxRevenueAmount: dto.maxRevenueAmount ?? null,
        },
      });
      return bracket;
    });
  }

  async updateBracket(
    bracketId: number,
    dto: UpdateRevenueRewardBracketDto,
    actorUserId: string,
  ) {
    const bracket = await this.getBracketOrThrow(bracketId);
    const ruleSet = await this.getOrThrow(bracket.rewardRuleSetId);
    this.assertDraft(ruleSet.status);
    return this.prisma.$transaction(async (tx) => {
      await this.claimDraftRuleSet(tx, bracket.rewardRuleSetId);
      const current = await tx.revenueRewardBracket.findUnique({
        where: { id: bracketId },
      });
      if (!current) this.throwBracketChanged();
      const nextMin = dto.minRevenueAmount ?? current.minRevenueAmount;
      const nextMax =
        dto.maxRevenueAmount !== undefined
          ? dto.maxRevenueAmount
          : current.maxRevenueAmount;
      this.assertBracketRangeValid(nextMin, nextMax);
      this.assertCommissionRateValid(
        dto.commissionRatePercent ?? current.commissionRatePercent,
      );
      const siblings = await tx.revenueRewardBracket.findMany({
        where: {
          rewardRuleSetId: current.rewardRuleSetId,
          id: { not: bracketId },
        },
      });
      this.assertNoOverlap(siblings, nextMin, nextMax);
      const updated = await tx.revenueRewardBracket.update({
        where: { id: bracketId },
        data: {
          label: dto.label,
          minRevenueAmount: dto.minRevenueAmount,
          maxRevenueAmount: dto.maxRevenueAmount,
          commissionRatePercent: dto.commissionRatePercent,
          rpmRatePer1000Views: dto.rpmRatePer1000Views,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'REVENUE_REWARD_BRACKET_UPDATED',
        entityType: 'RevenueRewardBracket',
        entityId: bracketId,
        beforeData: {
          label: current.label,
          minRevenueAmount: current.minRevenueAmount.toNumber(),
          maxRevenueAmount: current.maxRevenueAmount?.toNumber() ?? null,
        },
        afterData: { ...dto },
      });
      return updated;
    });
  }

  async deleteBracket(bracketId: number, actorUserId: string) {
    const bracket = await this.getBracketOrThrow(bracketId);
    const ruleSet = await this.getOrThrow(bracket.rewardRuleSetId);
    this.assertDraft(ruleSet.status);
    return this.prisma.$transaction(async (tx) => {
      await this.claimDraftRuleSet(tx, bracket.rewardRuleSetId);
      const current = await tx.revenueRewardBracket.findUnique({
        where: { id: bracketId },
      });
      if (!current) this.throwBracketChanged();
      await tx.revenueRewardBracket.delete({ where: { id: bracketId } });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'REVENUE_REWARD_BRACKET_DELETED',
        entityType: 'RevenueRewardBracket',
        entityId: bracketId,
        beforeData: {
          rewardRuleSetId: current.rewardRuleSetId,
          label: current.label,
        },
      });
    });
  }

  private async getBracketOrThrow(id: number) {
    const bracket = await this.prisma.revenueRewardBracket.findUnique({
      where: { id },
    });
    if (!bracket) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy mốc thưởng doanh thu',
        HttpStatus.NOT_FOUND,
      );
    }
    return bracket;
  }

  private assertDraft(status: RewardRuleSetStatus) {
    if (status !== RewardRuleSetStatus.DRAFT) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Chỉ được thêm/sửa/xóa mốc thưởng khi bộ cấu hình đang ở trạng thái DRAFT',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async claimDraftRuleSet(
    tx: Prisma.TransactionClient,
    ruleSetId: number,
  ) {
    const claimed = await tx.rewardRuleSet.updateMany({
      where: { id: ruleSetId, status: RewardRuleSetStatus.DRAFT },
      // No-op về giá trị nhưng vẫn là UPDATE ở PostgreSQL, dùng để khóa row parent.
      data: { status: RewardRuleSetStatus.DRAFT },
    });
    if (claimed.count !== 1) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Bộ cấu hình không còn ở trạng thái DRAFT',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async runSerializable<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || error.code === 'P2002')
      ) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Cấu hình thưởng vừa được thay đổi, vui lòng thực hiện lại',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  private throwBracketChanged(): never {
    throw new AppException(
      ErrorCode.CONFLICT,
      'Mốc thưởng vừa được thay đổi bởi một yêu cầu khác',
      HttpStatus.CONFLICT,
    );
  }

  private assertBracketRangeValid(
    min: Prisma.Decimal.Value,
    max?: Prisma.Decimal.Value | null,
  ) {
    if (max != null && new Prisma.Decimal(max).lte(new Prisma.Decimal(min))) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'maxRevenueAmount phải lớn hơn minRevenueAmount (hoặc bỏ trống cho bracket cao nhất)',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Overlap check theo nửa khoảng [min, max) — max = null/undefined nghĩa là +vô cực. */
  private assertNoOverlap(
    siblings: {
      label: string;
      minRevenueAmount: Prisma.Decimal;
      maxRevenueAmount: Prisma.Decimal | null;
    }[],
    min: Prisma.Decimal.Value,
    max?: Prisma.Decimal.Value | null,
  ) {
    const newMin = new Prisma.Decimal(min);
    const newMax = max == null ? null : new Prisma.Decimal(max);
    const overlapping = siblings.find((sibling) => {
      const startsBeforeSiblingEnds =
        sibling.maxRevenueAmount === null ||
        newMin.lt(sibling.maxRevenueAmount);
      const siblingStartsBeforeNewEnds =
        newMax === null || sibling.minRevenueAmount.lt(newMax);
      return startsBeforeSiblingEnds && siblingStartsBeforeNewEnds;
    });
    if (overlapping) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Khoảng doanh thu chồng lấn với mốc "${overlapping.label}"`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertCommissionRateValid(value: Prisma.Decimal.Value) {
    if (new Prisma.Decimal(value).gt(100)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'commissionRatePercent không được lớn hơn 100',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /** Mọi doanh thu không âm phải khớp đúng một bracket trước khi ruleset được đưa vào sử dụng. */
  private assertCompleteBracketCoverage(
    brackets: Array<{
      minRevenueAmount: Prisma.Decimal;
      maxRevenueAmount: Prisma.Decimal | null;
    }>,
  ) {
    if (brackets.length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Cần cấu hình ít nhất một mốc doanh thu trước khi activate',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!brackets[0].minRevenueAmount.equals(0)) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Mốc doanh thu đầu tiên phải bắt đầu từ 0',
        HttpStatus.BAD_REQUEST,
      );
    }
    for (let index = 0; index < brackets.length - 1; index += 1) {
      const currentMax = brackets[index].maxRevenueAmount;
      const nextMin = brackets[index + 1].minRevenueAmount;
      if (currentMax === null || !currentMax.equals(nextMin)) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Các mốc doanh thu phải liên tục, không được có khoảng trống',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    if (brackets.at(-1)?.maxRevenueAmount !== null) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Mốc doanh thu cao nhất phải để trống giới hạn trên',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertPeriodExists(periodId: number) {
    const period = await this.prisma.payrollPeriod.findUnique({
      where: { id: periodId },
    });
    if (!period) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'effectiveFromPeriodId không tồn tại',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
