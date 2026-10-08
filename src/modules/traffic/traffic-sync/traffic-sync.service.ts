import { HttpStatus, Injectable } from '@nestjs/common';
import {
  Prisma,
  type EmployeeTrafficRecord,
  type TrafficPlatform,
  type TrafficSyncItemStatus,
} from '@prisma/client';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { forEachConcurrent } from '../../../common/utils/for-each-concurrent';
import {
  paginate,
  toSkipTake,
  type PaginationQueryDto,
} from '../../../common/utils/pagination.dto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthorizationService } from '../../access-control/authorization.service';
import type { ResolvedScope } from '../../../common/types/resolved-scope.types';
import { PeriodScopeService } from '../../access-control/period-scope.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { AutomationGenVideoClient } from '../../../common/clients/automation-gen-video.client';
import { matchEmployeesByEmailOrName } from '../../../common/utils/employee-identity-matcher';
import { buildLinkedTeamScopeWhere } from '../../../common/utils/linked-team-scope.util';
import type { TriggerTrafficSyncDto } from './dto/traffic-sync.dto';
import {
  normalizeEmail,
  selectLatestRowPerPerson,
  trafficRowKey,
  type NormalizedTrafficRow,
  type TrafficPlatformValue,
} from './traffic-report.mapper';

const SOURCE_SYSTEM = 'AUTOMATION_GEN_VIDEO';

// Mỗi người ghi tối đa 4 bản ghi (4 nền tảng), lần lượt trong các transaction độc lập — nên mức
// này chính là số connection tối đa mà đồng bộ chiếm cùng lúc.
//
// KHÔNG nâng lên: giới hạn thật không phải `connection_limit=10` trên DATABASE_URL mà là
// pool_size=15 của Supabase session pooler, dùng chung cho TOÀN project — mọi instance API, mọi
// máy dev đang chạy đều ăn chung 15 slot đó. Thử mức 8 thì Postgres trả thẳng
// `FATAL: (EMAXCONNSESSION) max clients reached in session mode` khi có instance thứ hai kết nối.
const TRAFFIC_SYNC_PERSON_CONCURRENCY = 4;

/**
 * Sau bao lâu thì một lượt còn kẹt `RUNNING` bị coi là chết.
 *
 * Cần thiết vì `traffic_sync_runs_one_running_per_period_idx` chặn hai lượt RUNNING trên cùng kỳ:
 * nếu tiến trình chết giữa chừng (hoặc chính câu update đánh dấu FAILED cũng không còn connection
 * để chạy), hàng RUNNING đó sẽ khoá cứng kỳ lương, không ai đồng bộ lại được nữa.
 */
const STALE_RUN_MINUTES = 15;

type ResolvedPerson = {
  row: NormalizedTrafficRow;
  recordKey: string;
  employeeId?: number;
  reason?: string;
};

type ExistingTrafficRecord = Pick<
  EmployeeTrafficRecord,
  'id' | 'platform' | 'views' | 'selfConfirmationStatus' | 'leaderReviewStatus'
>;

/** Phần định danh dòng nguồn, lặp lại y nguyên trên mọi `TrafficSyncRunItem` của một người. */
type SyncItemCommon = {
  trafficSyncRunId: string;
  externalRecordKey: string;
  externalEmail: string | null;
  externalName: string | null;
  externalTeam: string | null;
  sourceReportDate: Date;
};

type PlatformSyncItemCommon = SyncItemCommon & {
  employeeId: number;
  platform: TrafficPlatform;
};

@Injectable()
export class TrafficSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceClient: AutomationGenVideoClient,
    private readonly auditLog: AuditLogService,
    private readonly authorization: AuthorizationService,
    private readonly periodScope: PeriodScopeService,
  ) {}

  async sync(dto: TriggerTrafficSyncDto, actorUserId: string) {
    const [period, scope] = await Promise.all([
      this.prisma.payrollPeriod.findUnique({
        where: { id: dto.payrollPeriodId },
      }),
      this.authorization.resolvePermissionScope(actorUserId, 'sync.trigger'),
    ]);
    if (!period) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy kỳ lương',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.assertCanSyncTeam(scope, dto.externalTeamName);

    const dateFrom = dto.dateFrom ?? toYmd(period.startDate);
    const dateTo = dto.dateTo ?? toYmd(period.endDate);
    if (dateFrom > dateTo) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'dateFrom phải nhỏ hơn hoặc bằng dateTo',
        HttpStatus.BAD_REQUEST,
      );
    }

    const running = await this.prisma.trafficSyncRun.findFirst({
      where: { payrollPeriodId: period.id, status: 'RUNNING' },
    });
    if (running) {
      const staleSince = Date.now() - STALE_RUN_MINUTES * 60_000;
      if (running.startedAt.getTime() > staleSince) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Kỳ lương này đang có một lượt đồng bộ traffic khác chạy',
          HttpStatus.CONFLICT,
        );
      }
      // Quá hạn = tiến trình đã chết. Đóng sổ lượt cũ để partial unique index nhả kỳ ra.
      await this.prisma.trafficSyncRun.update({
        where: { id: running.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorSummary: `Lượt đồng bộ bị treo quá ${STALE_RUN_MINUTES} phút và đã bị đánh dấu thất bại để mở khoá kỳ lương`,
        },
      });
    }

    const run = await this.prisma.trafficSyncRun.create({
      data: {
        payrollPeriodId: period.id,
        dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
        dateTo: new Date(`${dateTo}T00:00:00.000Z`),
        externalTeamName: dto.externalTeamName ?? null,
        triggeredByUserId: actorUserId,
      },
    });

    // Cùng quy tắc với đồng bộ KPI: chỉ ghi đè số liệu khi kỳ còn đang nhập. Từ IN_REVIEW trở đi
    // con số phải đứng yên cho Leader duyệt, nên run vẫn lưu lại (ai bấm, lúc nào) nhưng SKIPPED.
    if (period.status !== 'OPEN') {
      return this.prisma.trafficSyncRun.update({
        where: { id: run.id },
        data: {
          status: 'SKIPPED',
          finishedAt: new Date(),
          errorSummary:
            period.status === 'CLOSED'
              ? 'Kỳ lương đã đóng nên dữ liệu được bảo vệ'
              : 'Chỉ đồng bộ traffic khi kỳ lương đang mở',
        },
        include: this.runInclude,
      });
    }

    try {
      const payload = await this.sourceClient.fetchTrafficReports({
        dateFrom,
        dateTo,
        team: dto.externalTeamName,
      });
      const people = selectLatestRowPerPerson(payload.rows);
      const resolved = await this.resolvePeople(period.id, people, scope);

      await forEachConcurrent(
        resolved,
        TRAFFIC_SYNC_PERSON_CONCURRENCY,
        (person) => this.applyPerson(run.id, actorUserId, period.id, person),
      );

      const counts = await this.countResults(run.id);
      const warnings = this.collectWarnings(resolved);
      return this.prisma.trafficSyncRun.update({
        where: { id: run.id },
        data: {
          status: this.resolveRunStatus(counts),
          finishedAt: new Date(),
          receivedRows: payload.rows.length,
          matchedEmployees: resolved.filter(
            (person) => person.employeeId != null,
          ).length,
          unmatchedRows: resolved.filter((person) => person.employeeId == null)
            .length,
          successfulRecords: counts.SUCCESS,
          skippedRecords: counts.SKIPPED,
          conflictRecords: counts.CONFLICT,
          failedRecords: counts.FAILED,
          warningCount: warnings.length,
          sourceWarnings: warnings,
        },
        include: this.runInclude,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Lỗi đồng bộ traffic không xác định';
      // Câu update này có thể hỏng theo cùng lý do với lỗi gốc (vd. hết connection). Nuốt lỗi phụ
      // để người gọi vẫn nhận đúng nguyên nhân đầu tiên; hàng RUNNING còn sót sẽ được lượt sau
      // dọn qua cơ chế STALE_RUN_MINUTES.
      try {
        await this.prisma.trafficSyncRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            errorSummary: message.slice(0, 1000),
          },
        });
      } catch {
        // bỏ qua: lỗi gốc mới là thứ cần ném ra
      }
      throw error;
    }
  }

  async list(query: PaginationQueryDto, userId: string) {
    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const where = await this.visibleRunsWhere(userId);
    const [runs, total] = await Promise.all([
      this.prisma.trafficSyncRun.findMany({
        where,
        skip,
        take,
        orderBy: { startedAt: 'desc' },
        include: this.runInclude,
      }),
      this.prisma.trafficSyncRun.count({ where }),
    ]);
    return paginate(runs.map(serializeRun), total, query.page, query.pageSize);
  }

  /** Team được chọn trong dialog đồng bộ, và user có được kéo toàn hệ thống hay không. */
  async listSyncableTeams(userId: string) {
    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'sync.trigger',
    );
    const teamWhere = buildLinkedTeamScopeWhere(scope);
    const teams = teamWhere
      ? await this.prisma.team.findMany({
          where: { ...teamWhere, status: 'ACTIVE' },
          select: { id: true, code: true, name: true, externalId: true },
          orderBy: { name: 'asc' },
        })
      : [];
    return { canSyncAllTeams: scope.type === 'ALL', teams };
  }

  async get(id: string, userId: string) {
    const where = await this.visibleRunsWhere(userId);
    // Lượt ngoài phạm vi trả 404 như không tồn tại, không tiết lộ traffic của team khác.
    const run = await this.prisma.trafficSyncRun.findFirst({
      where: { ...where, id },
      include: {
        ...this.runInclude,
        items: {
          orderBy: { id: 'asc' },
          include: {
            employee: { select: { id: true, fullName: true } },
          },
        },
      },
    });
    if (!run) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy lượt đồng bộ traffic',
        HttpStatus.NOT_FOUND,
      );
    }
    return serializeRun(run);
  }

  /**
   * Scope ALL được kéo toàn hệ thống hoặc bất kỳ team nào. Leader (scope TEAM) bắt buộc chọn một
   * team mình quản lý: kéo toàn hệ thống sẽ ghi traffic và lưu nhật ký của người thuộc team khác.
   * `externalTeamName` là tên team AGV, được đồng bộ nguyên văn thành `Team.name` bên lương.
   */
  private async assertCanSyncTeam(
    scope: ResolvedScope,
    externalTeamName: string | undefined,
  ) {
    if (scope.type === 'ALL') return;
    const teamWhere = buildLinkedTeamScopeWhere(scope);
    const team =
      teamWhere && externalTeamName
        ? await this.prisma.team.findFirst({
            where: { ...teamWhere, name: externalTeamName },
            select: { id: true },
          })
        : null;
    if (!team) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        externalTeamName
          ? 'Bạn chỉ được đồng bộ traffic cho team thuộc phạm vi quản lý của mình'
          : 'Hãy chọn team bạn quản lý; chỉ tài khoản phạm vi toàn hệ thống mới được đồng bộ toàn bộ',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** TrafficSyncRun chỉ lưu tên team AGV; lượt toàn hệ thống (null) chỉ scope ALL mới xem được. */
  private async visibleRunsWhere(
    userId: string,
  ): Promise<Prisma.TrafficSyncRunWhereInput> {
    const scope = await this.authorization.resolvePermissionScope(
      userId,
      'sync.view',
    );
    if (scope.type === 'ALL') return {};
    const teamWhere = buildLinkedTeamScopeWhere(scope);
    if (!teamWhere) return { id: { in: [] } };
    const teams = await this.prisma.team.findMany({
      where: teamWhere,
      select: { name: true },
    });
    return { externalTeamName: { in: teams.map((team) => team.name) } };
  }

  /**
   * Gắn mỗi dòng nguồn vào một nhân sự của kỳ.
   *
   * Chỉ xét nhân sự CÓ trong snapshot của kỳ: `employee_traffic_records` là dữ liệu theo kỳ, và
   * luồng nhập tay cũng chặn người ngoài snapshot (`TrafficService.getSnapshotOrThrow`).
   * Leader chỉ được khớp vào nhân sự thuộc team mình trong kỳ, để fallback email/tên không ghi
   * nhầm sang người team khác.
   * Thứ tự ưu tiên: mapping đã chốt trong `ExternalEmployeeIdentity` → khớp email/tên.
   */
  private async resolvePeople(
    periodId: number,
    people: readonly NormalizedTrafficRow[],
    scope: ResolvedScope,
  ): Promise<ResolvedPerson[]> {
    const allowedEmployeeIds = await this.periodScope.resolveEmployeeIds(
      scope,
      periodId,
      null,
    );
    const snapshots = await this.prisma.payrollPeriodEmployeeSnapshot.findMany({
      where: {
        payrollPeriodId: periodId,
        ...(allowedEmployeeIds === 'ALL'
          ? {}
          : { employeeId: { in: allowedEmployeeIds } }),
      },
      select: {
        employee: {
          select: {
            id: true,
            fullName: true,
            user: { select: { email: true } },
            externalIdentities: {
              where: { sourceSystem: SOURCE_SYSTEM },
              select: { lastKnownEmail: true },
            },
          },
        },
      },
    });
    const employees = snapshots.map((snapshot) => snapshot.employee);

    const employeeIdByIdentityEmail = new Map<string, number[]>();
    for (const employee of employees) {
      for (const identity of employee.externalIdentities) {
        const email = normalizeEmail(identity.lastKnownEmail);
        if (!email) continue;
        employeeIdByIdentityEmail.set(email, [
          ...(employeeIdByIdentityEmail.get(email) ?? []),
          employee.id,
        ]);
      }
    }

    const resolved: ResolvedPerson[] = [];
    const needFallback: NormalizedTrafficRow[] = [];
    for (const row of people) {
      const recordKey = trafficRowKey(row) ?? `name:${row.name ?? ''}`;
      const candidates = row.email
        ? (employeeIdByIdentityEmail.get(row.email) ?? [])
        : [];
      if (candidates.length === 1) {
        resolved.push({ row, recordKey, employeeId: candidates[0] });
      } else if (candidates.length > 1) {
        resolved.push({
          row,
          recordKey,
          reason:
            'Email khớp nhiều nhân sự đã map từ VCBI; bỏ qua để tránh ghi nhầm',
        });
      } else {
        needFallback.push(row);
      }
    }

    if (needFallback.length > 0) {
      const matches = matchEmployeesByEmailOrName(
        employees.map((employee) => ({
          id: employee.id,
          fullName: employee.fullName,
          user: employee.user,
        })),
        needFallback.map((row) => ({
          // Matcher khoá theo `user_id`; traffic không có user_id nên dùng luôn khoá dòng nguồn.
          user_id: trafficRowKey(row) ?? `name:${row.name ?? ''}`,
          email: row.email ?? '',
          full_name: row.name ?? '',
        })),
      );
      for (const row of needFallback) {
        const recordKey = trafficRowKey(row) ?? `name:${row.name ?? ''}`;
        const match = matches.get(recordKey);
        resolved.push({
          row,
          recordKey,
          employeeId: match?.employeeId,
          reason: match?.employeeId
            ? undefined
            : (match?.reason ??
              'Không tìm thấy nhân sự trong kỳ khớp email hoặc tên'),
        });
      }
    }

    return resolved;
  }

  private async applyPerson(
    runId: string,
    actorUserId: string,
    periodId: number,
    person: ResolvedPerson,
  ) {
    const common: SyncItemCommon = {
      trafficSyncRunId: runId,
      externalRecordKey: person.recordKey.slice(0, 300),
      externalEmail: person.row.email,
      externalName: person.row.name,
      externalTeam: person.row.team,
      sourceReportDate: new Date(`${person.row.reportDate}T00:00:00.000Z`),
    };

    if (!person.employeeId) {
      await this.prisma.trafficSyncRunItem.create({
        data: { ...common, resultStatus: 'SKIPPED', message: person.reason },
      });
      return;
    }

    const existingRecords = await this.prisma.employeeTrafficRecord.findMany({
      where: { employeeId: person.employeeId, payrollPeriodId: periodId },
      select: {
        id: true,
        platform: true,
        views: true,
        selfConfirmationStatus: true,
        leaderReviewStatus: true,
      },
    });
    const existingByPlatform = new Map(
      existingRecords.map((record) => [record.platform, record]),
    );

    // Nhánh KHÔNG ghi employee_traffic_records (0 view, hoặc bản ghi đã khoá) chỉ sinh ra một
    // dòng nhật ký. Gom lại ghi một lần: mỗi round-trip sang Supabase Singapore tốn ~350ms, mà
    // phần lớn nền tảng của phần lớn người rơi vào đúng các nhánh này.
    const pendingItems: Prisma.TrafficSyncRunItemCreateManyInput[] = [];

    for (const value of person.row.platforms) {
      const previous = existingByPlatform.get(value.platform) ?? null;
      const itemCommon = {
        ...common,
        employeeId: person.employeeId,
        platform: value.platform,
      };
      try {
        const pending = await this.applyPlatform(
          itemCommon,
          actorUserId,
          periodId,
          person.employeeId,
          value,
          previous,
        );
        if (pending) pendingItems.push(pending);
      } catch (error) {
        // Một nền tảng lỗi không được làm hỏng ba nền tảng còn lại của cùng người.
        pendingItems.push({
          ...itemCommon,
          resultStatus: 'FAILED',
          incomingViews: value.views,
          previousViews: previous?.views ?? null,
          employeeTrafficRecordId: previous?.id ?? null,
          message:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : 'Lỗi ghi traffic không xác định',
        });
      }
    }

    if (pendingItems.length > 0) {
      await this.prisma.trafficSyncRunItem.createMany({ data: pendingItems });
    }
  }

  /**
   * Trả về dòng nhật ký cần ghi, hoặc `null` khi đã ghi xong ngay trong transaction cùng với
   * bản ghi traffic (nhánh này phải nguyên tử nên không gom lại được).
   */
  private async applyPlatform(
    common: PlatformSyncItemCommon,
    actorUserId: string,
    periodId: number,
    employeeId: number,
    value: TrafficPlatformValue,
    previous: ExistingTrafficRecord | null,
  ): Promise<Prisma.TrafficSyncRunItemCreateManyInput | null> {
    // Nguồn không có số cho nền tảng này. Không tạo bản ghi 0 view (API đọc đã tự sinh sẵn ô
    // trống cho nền tảng thiếu), và cũng không hạ số đã nhập tay về 0.
    if (value.views === 0n) {
      return {
        ...common,
        resultStatus: 'SKIPPED' as const,
        incomingViews: 0n,
        previousViews: previous?.views ?? null,
        appliedViews: previous?.views ?? null,
        employeeTrafficRecordId: previous?.id ?? null,
        message: previous
          ? 'Nguồn không có số cho nền tảng này; giữ giá trị hiện tại'
          : 'Nguồn không có số cho nền tảng này',
      };
    }

    // Đã tự xác nhận hoặc đã được Leader duyệt → khoá, đồng bộ không được ghi đè. Lệch số thì
    // báo CONFLICT để người phụ trách tự xử lý, trùng số thì coi như đã khớp nguồn.
    if (
      previous &&
      (previous.selfConfirmationStatus === 'CONFIRMED' ||
        previous.leaderReviewStatus === 'APPROVED')
    ) {
      const unchanged = previous.views === value.views;
      return {
        ...common,
        resultStatus: unchanged ? ('SUCCESS' as const) : ('CONFLICT' as const),
        previousViews: previous.views,
        incomingViews: value.views,
        appliedViews: previous.views,
        employeeTrafficRecordId: previous.id,
        hasConflict: !unchanged,
        message: unchanged
          ? 'Giá trị đã khoá trùng với nguồn'
          : 'Traffic đã xác nhận/duyệt nên không bị ghi đè',
      };
    }

    await this.prisma.$transaction(async (tx) => {
      const saved = await tx.employeeTrafficRecord.upsert({
        where: {
          employeeId_payrollPeriodId_platform_platformName: {
            employeeId,
            payrollPeriodId: periodId,
            platform: value.platform,
            platformName: '',
          },
        },
        create: {
          employeeId,
          payrollPeriodId: periodId,
          platform: value.platform,
          views: value.views,
          dataSource: 'AUTOMATION_GEN_VIDEO',
          syncedAt: new Date(),
          sourceReportDate: common.sourceReportDate,
          sourceChannel: value.channel,
        },
        update: {
          views: value.views,
          dataSource: 'AUTOMATION_GEN_VIDEO',
          syncedAt: new Date(),
          sourceReportDate: common.sourceReportDate,
          sourceChannel: value.channel,
          // Cố ý KHÔNG đụng tới leaderRejectionReason / trạng thái duyệt: đồng bộ hành xử đúng
          // như một lần sửa số tay, và chính `selfConfirm()` mới là chỗ xoá lý do từ chối.
        },
      });
      await tx.trafficSyncRunItem.create({
        data: {
          ...common,
          resultStatus: 'SUCCESS',
          previousViews: previous?.views,
          incomingViews: value.views,
          appliedViews: saved.views,
          employeeTrafficRecordId: saved.id,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'TRAFFIC_SYNCED',
        entityType: 'EmployeeTrafficRecord',
        entityId: String(saved.id),
        targetEmployeeId: employeeId,
        payrollPeriodId: periodId,
        beforeData: previous ? { views: previous.views.toString() } : undefined,
        afterData: {
          platform: value.platform,
          views: saved.views.toString(),
          sourceReportDate: common.sourceReportDate,
          source: SOURCE_SYSTEM,
        },
      });
    });
    return null;
  }

  /** Nền tảng nguồn có số nhưng hệ thống lương chưa hỗ trợ — nêu rõ thay vì bỏ im lặng. */
  private collectWarnings(resolved: readonly ResolvedPerson[]) {
    const warnings: { code: string; email: string | null; message: string }[] =
      [];
    for (const person of resolved) {
      for (const unmapped of person.row.unmappedPlatforms) {
        warnings.push({
          code: 'UNSUPPORTED_PLATFORM',
          email: person.row.email,
          message: `Nguồn có ${unmapped.views} view ở nền tảng "${unmapped.platform}" nhưng chưa đồng bộ được nền tảng này; nhập tay ở mục nền tảng khác nếu cần tính`,
        });
      }
    }
    return warnings;
  }

  private async countResults(runId: string) {
    const grouped = await this.prisma.trafficSyncRunItem.groupBy({
      by: ['resultStatus'],
      where: { trafficSyncRunId: runId },
      _count: { _all: true },
    });
    const counts: Record<TrafficSyncItemStatus, number> = {
      SUCCESS: 0,
      SKIPPED: 0,
      CONFLICT: 0,
      FAILED: 0,
    };
    for (const group of grouped) {
      counts[group.resultStatus] = group._count._all;
    }
    return counts;
  }

  private resolveRunStatus(counts: Record<TrafficSyncItemStatus, number>) {
    if (counts.FAILED > 0 && counts.SUCCESS === 0) return 'FAILED' as const;
    if (counts.FAILED > 0 || counts.CONFLICT > 0) return 'PARTIAL' as const;
    return 'SUCCESS' as const;
  }

  private readonly runInclude = {
    triggeredBy: { select: { id: true, fullName: true } },
    payrollPeriod: { select: { id: true, code: true, name: true } },
  } satisfies Prisma.TrafficSyncRunInclude;
}

/** `Date` của cột `@db.Date` được Prisma trả về ở UTC midnight — đọc lại đúng bằng getUTC*. */
function toYmd(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** BigInt không đi qua JSON.stringify được; trả view dưới dạng chuỗi như phần còn lại của traffic. */
function serializeRun<T extends Record<string, unknown>>(run: T): T {
  const items = run.items;
  if (!Array.isArray(items)) return run;
  return {
    ...run,
    items: items.map((item: Record<string, unknown>) => ({
      ...item,
      previousViews: bigIntToString(item.previousViews),
      incomingViews: bigIntToString(item.incomingViews),
      appliedViews: bigIntToString(item.appliedViews),
    })),
  };
}

function bigIntToString(value: unknown) {
  return typeof value === 'bigint' ? value.toString() : (value ?? null);
}
