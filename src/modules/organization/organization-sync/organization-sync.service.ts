import { HttpStatus, Injectable } from '@nestjs/common';
import {
  DepartmentStatus,
  EmploymentStatus,
  OrgSyncItemStatus,
  OrgSyncStatus,
  Prisma,
  TeamStatus,
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
import {
  AutomationGenVideoClient,
  type AutomationGenVideoTeamDetail,
  type AutomationGenVideoTeamMember,
} from '../../../common/clients/automation-gen-video.client';
import { matchEmployeesByEmailOrName } from '../../../common/utils/employee-identity-matcher';

const SOURCE_SYSTEM = 'AUTOMATION_GEN_VIDEO';
/// Mã nhóm nghiệp vụ theo contract của AutomationGenVideo — nguồn chỉ sinh ra nhân sự Marketing
/// nên sync luôn gán đúng hai nhóm này. Nhóm bị xóa khỏi danh mục thì sync bỏ qua, không dừng.
const SYNC_EDITOR_GROUP_CODE = 'EDITOR';
const SYNC_CONTENT_CREATOR_GROUP_CODE = 'CONTENT_CREATOR';
const MARKETING_DEPARTMENT_CODE = 'MARKETING';
const ORG_SYNC_CONCURRENCY = 4;
const TEAM_SYNC_CONCURRENCY = 2;

@Injectable()
export class OrganizationSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AutomationGenVideoClient,
  ) {}

  async syncAllTeams(triggeredByUserId: string) {
    const sourceTeams = await this.client.fetchTeams();
    const teamIds = [...new Set(sourceTeams.map((team) => team.id))];
    const runs: Awaited<ReturnType<OrganizationSyncService['syncTeam']>>[] = [];
    const failedTeamIds: string[] = [];

    await forEachConcurrent(teamIds, TEAM_SYNC_CONCURRENCY, async (teamId) => {
      try {
        runs.push(await this.syncTeam(teamId, triggeredByUserId));
      } catch {
        // syncTeam đã ghi FAILED vào OrgSyncRun; batch vẫn tiếp tục với các team còn lại.
        failedTeamIds.push(teamId);
      }
    });

    const successfulTeams = runs.filter(
      (run) => run.status === 'SUCCESS',
    ).length;
    const partialTeams = runs.filter((run) => run.status === 'PARTIAL').length;
    const failedTeams =
      failedTeamIds.length +
      runs.filter((run) => run.status === 'FAILED').length;

    return {
      totalTeams: teamIds.length,
      successfulTeams,
      partialTeams,
      failedTeams,
      failedTeamIds,
      runs,
    };
  }

  async syncTeam(externalTeamId: string, triggeredByUserId: string) {
    const run = await this.prisma.orgSyncRun.create({
      data: { externalTeamId, triggeredByUserId },
    });

    try {
      const team = await this.client.fetchTeamForPayrollSync(externalTeamId);
      const localTeam = await this.upsertTeam(team);

      const sourceUserIds = team.members.map((member) => member.user_id);
      const [linkedIdentities, fallbackCandidates] = await Promise.all([
        this.prisma.externalEmployeeIdentity.findMany({
          where: {
            sourceSystem: SOURCE_SYSTEM,
            externalUserId: { in: sourceUserIds },
          },
          select: { externalUserId: true, employeeId: true },
        }),
        this.prisma.employee.findMany({
          where: {
            externalIdentities: { none: { sourceSystem: SOURCE_SYSTEM } },
          },
          select: {
            id: true,
            fullName: true,
            user: { select: { email: true } },
            externalIdentities: {
              select: { lastKnownEmail: true },
              orderBy: { lastSyncedAt: 'desc' },
              take: 1,
            },
          },
        }),
      ]);
      const linkedEmployeeByExternalId = new Map(
        linkedIdentities.map((identity) => [
          identity.externalUserId,
          identity.employeeId,
        ]),
      );
      const fallbackMembers = team.members.filter(
        (member) => !linkedEmployeeByExternalId.has(member.user_id),
      );
      const fallbackMatches = matchEmployeesByEmailOrName(
        fallbackCandidates.map((employee) => ({
          id: employee.id,
          fullName: employee.fullName,
          email:
            employee.user?.email ??
            employee.externalIdentities?.[0]?.lastKnownEmail ??
            null,
        })),
        fallbackMembers,
      );

      const syncEmployeeGroupIds = await this.resolveSyncEmployeeGroupIds();
      const externalIdToLocalId = new Map<string, number>();
      let successfulRecords = 0;
      let failedRecords = 0;
      let skippedRecords = 0;

      await forEachConcurrent(
        team.members,
        ORG_SYNC_CONCURRENCY,
        async (member) => {
          const fallbackMatch = fallbackMatches.get(member.user_id);
          const fallbackEmployeeId =
            linkedEmployeeByExternalId.get(member.user_id) ??
            fallbackMatch?.employeeId;
          if (fallbackEmployeeId == null && fallbackMatch?.ambiguous) {
            skippedRecords += 1;
            await this.recordItem(
              run.id,
              member.user_id,
              OrgSyncItemStatus.SKIPPED,
              null,
              fallbackMatch.reason,
            );
            return;
          }
          const isTeamLeader = member.user_id === team.leader_id;
          try {
            const employee = await this.upsertEmployeeBase(
              member,
              localTeam.id,
              isTeamLeader,
              syncEmployeeGroupIds,
              fallbackEmployeeId,
            );
            await Promise.all([
              this.upsertExternalIdentity(employee.id, member),
              this.upsertMembership(employee.id, localTeam.id, team.id, member),
            ]);
            externalIdToLocalId.set(member.user_id, employee.id);
            successfulRecords += 1;
            await this.recordItem(
              run.id,
              member.user_id,
              OrgSyncItemStatus.SUCCESS,
              employee.id,
            );
          } catch (err) {
            failedRecords += 1;
            await this.recordItem(
              run.id,
              member.user_id,
              OrgSyncItemStatus.FAILED,
              null,
              errorMessageOf(err),
            );
          }
        },
      );

      const hierarchyIds = new Set(
        team.members.flatMap((member) =>
          [team.leader_id, member.manager_id].filter(
            (id): id is string => id != null,
          ),
        ),
      );
      const missingHierarchyIds = [...hierarchyIds].filter(
        (externalId) => !externalIdToLocalId.has(externalId),
      );
      if (missingHierarchyIds.length > 0) {
        const relatedIdentities =
          await this.prisma.externalEmployeeIdentity.findMany({
            where: {
              sourceSystem: SOURCE_SYSTEM,
              externalUserId: { in: missingHierarchyIds },
            },
            select: { employeeId: true, externalUserId: true },
          });
        for (const identity of relatedIdentities) {
          externalIdToLocalId.set(identity.externalUserId, identity.employeeId);
        }
      }

      const memberByExternalId = new Map(
        team.members.map((member) => [member.user_id, member]),
      );
      await forEachConcurrent(
        [...externalIdToLocalId.entries()].filter(([externalId]) =>
          memberByExternalId.has(externalId),
        ),
        ORG_SYNC_CONCURRENCY,
        async ([externalId, employeeId]) => {
          const member = memberByExternalId.get(externalId)!;
          await this.assignHierarchy(
            employeeId,
            localTeam.id,
            team.leader_id,
            member.manager_id,
            externalIdToLocalId,
          );
        },
      );

      // Thành viên biến mất khỏi payload chỉ rời team này, không làm hồ sơ Employee nghỉ việc và
      // không ảnh hưởng các membership ở team khác.
      await this.prisma.employeeTeamMembership.updateMany({
        where: {
          teamId: localTeam.id,
          sourceSystem: SOURCE_SYSTEM,
          employeeId: { notIn: [...externalIdToLocalId.values()] },
          isActive: true,
        },
        data: { isActive: false, leftAt: new Date(), lastSyncedAt: new Date() },
      });
      await this.repairInactivePrimaryMemberships(localTeam.id);

      const failedTotal = failedRecords + skippedRecords;
      const status =
        failedTotal === 0
          ? OrgSyncStatus.SUCCESS
          : successfulRecords > 0
            ? OrgSyncStatus.PARTIAL
            : OrgSyncStatus.FAILED;

      return await this.prisma.orgSyncRun.update({
        where: { id: run.id },
        data: {
          status,
          finishedAt: new Date(),
          totalRecords: team.members.length,
          successfulRecords,
          failedRecords: failedTotal,
        },
      });
    } catch (err) {
      await this.prisma.orgSyncRun.update({
        where: { id: run.id },
        data: {
          status: OrgSyncStatus.FAILED,
          finishedAt: new Date(),
          errorSummary: errorMessageOf(err),
        },
      });
      throw err;
    }
  }

  async listRuns(query: PaginationQueryDto) {
    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.orgSyncRun.findMany({
        skip,
        take,
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.orgSyncRun.count(),
    ]);
    return paginate(data, total, query.page, query.pageSize);
  }

  async getRun(id: string) {
    const run = await this.prisma.orgSyncRun.findUnique({
      where: { id },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!run) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy lượt đồng bộ',
        HttpStatus.NOT_FOUND,
      );
    }
    return run;
  }

  private async upsertTeam(team: AutomationGenVideoTeamDetail) {
    const marketingDepartment = await this.prisma.department.upsert({
      where: { code: MARKETING_DEPARTMENT_CODE },
      update: { name: 'Marketing', status: DepartmentStatus.ACTIVE },
      create: {
        code: MARKETING_DEPARTMENT_CODE,
        name: 'Marketing',
        status: DepartmentStatus.ACTIVE,
      },
    });
    const existing = await this.prisma.team.findUnique({
      where: { externalId: team.id },
    });
    const status = team.is_active ? TeamStatus.ACTIVE : TeamStatus.INACTIVE;

    if (existing) {
      return this.prisma.team.update({
        where: { id: existing.id },
        data: {
          name: team.name,
          status,
          departmentId: marketingDepartment.id,
          lastSyncedAt: new Date(),
        },
      });
    }

    const code = await this.generateTeamCode(team.name);
    return this.prisma.team.create({
      data: {
        code,
        name: team.name,
        status,
        departmentId: marketingDepartment.id,
        sourceSystem: SOURCE_SYSTEM,
        externalId: team.id,
        lastSyncedAt: new Date(),
      },
    });
  }

  /** Bỏ dấu tiếng Việt bằng NFD + lọc theo code point (tránh literal ký tự combining-mark khó gõ/dễ gõ nhầm trong regex). */
  private stripDiacritics(value: string): string {
    return value
      .normalize('NFD')
      .split('')
      .filter((ch) => ch.charCodeAt(0) < 0x0300 || ch.charCodeAt(0) > 0x036f)
      .join('');
  }

  private async generateTeamCode(name: string): Promise<string> {
    const base =
      this.stripDiacritics(name)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'TEAM';

    let candidate = base;
    let suffix = 1;
    while (await this.prisma.team.findUnique({ where: { code: candidate } })) {
      suffix += 1;
      candidate = `${base}-${suffix}`.slice(0, 50);
    }
    return candidate;
  }

  /** Đọc một lần mỗi lượt sync thay vì tra danh mục cho từng nhân sự. */
  private async resolveSyncEmployeeGroupIds() {
    const groups = await this.prisma.employeeGroup.findMany({
      where: {
        code: {
          in: [SYNC_EDITOR_GROUP_CODE, SYNC_CONTENT_CREATOR_GROUP_CODE],
        },
      },
      select: { id: true, code: true },
    });
    return {
      editorId:
        groups.find((group) => group.code === SYNC_EDITOR_GROUP_CODE)?.id ??
        null,
      contentCreatorId:
        groups.find((group) => group.code === SYNC_CONTENT_CREATOR_GROUP_CODE)
          ?.id ?? null,
    };
  }

  private async upsertEmployeeBase(
    member: AutomationGenVideoTeamMember,
    teamId: number,
    isTeamLeader: boolean,
    syncEmployeeGroupIds: {
      editorId: number | null;
      contentCreatorId: number | null;
    },
    fallbackEmployeeId?: number,
  ) {
    const createEmployeeCode = generateFallbackEmployeeCode(member.user_id);
    const { employmentStatus, leftAt } = deriveEmploymentStatus(member);
    const jobTitle = deriveJobTitle(member, isTeamLeader);

    // task-auto coi content creator là vai trò bổ sung cạnh editor.
    const employeeGroupIds = [
      syncEmployeeGroupIds.editorId,
      ...(member.is_content_creator
        ? [syncEmployeeGroupIds.contentCreatorId]
        : []),
    ].filter((groupId): groupId is number => groupId !== null);

    const data = {
      fullName: member.full_name,
      jobTitle,
      sourceSystem: SOURCE_SYSTEM,
      lastSyncedAt: new Date(),
    };

    if (fallbackEmployeeId != null) {
      return this.prisma.employee.update({
        where: { id: fallbackEmployeeId },
        data: {
          ...data,
          employeeGroups: {
            set: employeeGroupIds.map((groupId) => ({ id: groupId })),
          },
        },
      });
    }

    const codeTaken = await this.prisma.employee.findUnique({
      where: { employeeCode: createEmployeeCode },
    });
    if (codeTaken) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `Mã nhân sự "${createEmployeeCode}" đã tồn tại (không phải do sync tạo ra)`,
        HttpStatus.CONFLICT,
      );
    }

    try {
      return await this.prisma.employee.create({
        data: {
          ...data,
          teamId,
          employeeCode: createEmployeeCode,
          employmentStatus,
          leftAt,
          // Giữ cột legacy trong giai đoạn chuyển đổi; mapping chuẩn nằm ở ExternalEmployeeIdentity.
          externalId: member.user_id,
          employeeGroups: {
            connect: employeeGroupIds.map((groupId) => ({ id: groupId })),
          },
        },
      });
    } catch (error) {
      // Cùng một user nguồn có thể xuất hiện ở nhiều team đang sync song song. Nếu request khác
      // vừa tạo nhân sự trước, dùng lại bản ghi đó thay vì đánh dấu FAILED vì unique externalId.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const concurrentlyLinked =
          await this.prisma.externalEmployeeIdentity.findUnique({
            where: {
              sourceSystem_externalUserId: {
                sourceSystem: SOURCE_SYSTEM,
                externalUserId: member.user_id,
              },
            },
            select: { employeeId: true },
          });
        const concurrentlyCreated = concurrentlyLinked
          ? { id: concurrentlyLinked.employeeId }
          : await this.prisma.employee.findUnique({
              where: { externalId: member.user_id },
              select: { id: true },
            });
        if (concurrentlyCreated) {
          return this.prisma.employee.update({
            where: { id: concurrentlyCreated.id },
            data: {
              ...data,
              employeeGroups: {
                set: employeeGroupIds.map((groupId) => ({ id: groupId })),
              },
            },
          });
        }
      }
      throw error;
    }
  }

  private async assignHierarchy(
    employeeId: number,
    teamId: number,
    teamLeaderExternalId: string | null,
    memberManagerExternalId: string | null,
    cache: Map<string, number>,
  ) {
    const data: {
      leaderEmployeeId?: number | null;
      managerEmployeeId?: number | null;
    } = {};

    if (teamLeaderExternalId === null) {
      data.leaderEmployeeId = null;
    } else {
      const leaderLocalId = await this.resolveLocalEmployeeId(
        teamLeaderExternalId,
        cache,
      );
      if (leaderLocalId && leaderLocalId !== employeeId) {
        data.leaderEmployeeId = leaderLocalId;
      }
    }

    if (memberManagerExternalId === null) {
      data.managerEmployeeId = null;
    } else {
      const managerLocalId = await this.resolveLocalEmployeeId(
        memberManagerExternalId,
        cache,
      );
      if (managerLocalId && managerLocalId !== employeeId) {
        data.managerEmployeeId = managerLocalId;
      }
    }

    if (Object.keys(data).length > 0) {
      const membership = await this.prisma.employeeTeamMembership.update({
        where: { employeeId_teamId: { employeeId, teamId } },
        data,
        select: { isPrimary: true },
      });
      if (membership.isPrimary) {
        await this.prisma.employee.update({ where: { id: employeeId }, data });
      }
    }
  }

  private async resolveLocalEmployeeId(
    externalId: string,
    cache: Map<string, number>,
  ): Promise<number | null> {
    const cached = cache.get(externalId);
    if (cached) return cached;
    const identity = await this.prisma.externalEmployeeIdentity.findUnique({
      where: {
        sourceSystem_externalUserId: {
          sourceSystem: SOURCE_SYSTEM,
          externalUserId: externalId,
        },
      },
      select: { employeeId: true },
    });
    if (identity) cache.set(externalId, identity.employeeId);
    return identity?.employeeId ?? null;
  }

  private upsertExternalIdentity(
    employeeId: number,
    member: AutomationGenVideoTeamMember,
  ) {
    const identity = {
      employeeId,
      externalEmployeeCode: member.employee_id?.trim() || null,
      lastKnownEmail: member.email?.trim().toLowerCase() || null,
      lastKnownName: member.full_name,
      lastSyncedAt: new Date(),
    };
    return this.prisma.externalEmployeeIdentity.upsert({
      where: {
        sourceSystem_externalUserId: {
          sourceSystem: SOURCE_SYSTEM,
          externalUserId: member.user_id,
        },
      },
      update: identity,
      create: {
        ...identity,
        sourceSystem: SOURCE_SYSTEM,
        externalUserId: member.user_id,
      },
    });
  }

  private async upsertMembership(
    employeeId: number,
    teamId: number,
    externalTeamId: string,
    member: AutomationGenVideoTeamMember,
  ) {
    const [existing, existingCount] = await Promise.all([
      this.prisma.employeeTeamMembership.findUnique({
        where: { employeeId_teamId: { employeeId, teamId } },
      }),
      this.prisma.employeeTeamMembership.count({
        where: { employeeId, isActive: true },
      }),
    ]);
    const isPrimary = existing?.isPrimary ?? existingCount === 0;
    const write = (primary: boolean) =>
      this.prisma.employeeTeamMembership.upsert({
        where: { employeeId_teamId: { employeeId, teamId } },
        update: {
          isPrimary: primary,
          ...(primary && !existing?.isActive
            ? { defaultSalaryWeightPercent: 100 }
            : {}),
          isActive: member.is_active && !member.deleted_at,
          leftAt: member.deleted_at ? new Date(member.deleted_at) : null,
          sourceSystem: SOURCE_SYSTEM,
          externalTeamId,
          lastSyncedAt: new Date(),
        },
        create: {
          employeeId,
          teamId,
          isPrimary: primary,
          defaultSalaryWeightPercent: primary ? 100 : 0,
          joinedAt: member.joined_at ? new Date(member.joined_at) : null,
          leftAt: member.deleted_at ? new Date(member.deleted_at) : null,
          isActive: member.is_active && !member.deleted_at,
          sourceSystem: SOURCE_SYSTEM,
          externalTeamId,
          lastSyncedAt: new Date(),
        },
      });
    let membership: Awaited<ReturnType<typeof write>>;
    try {
      membership = await write(isPrimary);
    } catch (error) {
      if (
        isPrimary &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        membership = await write(false);
      } else {
        throw error;
      }
    }
    if (membership.isPrimary) {
      await this.prisma.employee.update({
        where: { id: employeeId },
        data: { teamId },
      });
    }
    return membership;
  }

  private recordItem(
    orgSyncRunId: string,
    externalRecordKey: string,
    resultStatus: OrgSyncItemStatus,
    employeeId: number | null,
    errorMessage?: string,
  ) {
    return this.prisma.orgSyncRunItem.create({
      data: {
        orgSyncRunId,
        externalRecordKey,
        employeeId: employeeId ?? undefined,
        resultStatus,
        errorMessage,
      },
    });
  }

  private async repairInactivePrimaryMemberships(teamId: number) {
    const inactivePrimaries = await this.prisma.employeeTeamMembership.findMany(
      {
        where: { teamId, isPrimary: true, isActive: false },
        select: { id: true, employeeId: true },
      },
    );
    for (const inactive of inactivePrimaries) {
      const replacement = await this.prisma.employeeTeamMembership.findFirst({
        where: { employeeId: inactive.employeeId, isActive: true },
        orderBy: [{ defaultSalaryWeightPercent: 'desc' }, { id: 'asc' }],
      });
      if (!replacement) continue;
      await this.prisma.$transaction([
        this.prisma.employeeTeamMembership.update({
          where: { id: inactive.id },
          data: { isPrimary: false },
        }),
        this.prisma.employeeTeamMembership.update({
          where: { id: replacement.id },
          data: { isPrimary: true },
        }),
        this.prisma.employee.update({
          where: { id: inactive.employeeId },
          data: {
            teamId: replacement.teamId,
            leaderEmployeeId: replacement.leaderEmployeeId,
            managerEmployeeId: replacement.managerEmployeeId,
          },
        }),
      ]);
    }
  }
}

/** Mã nội bộ ổn định theo UUID tài khoản nguồn; không bị thay bằng employee_id không sạch. */
function generateFallbackEmployeeCode(externalUserId: string): string {
  return `NV-AGV-${externalUserId.replace(/-/g, '').toUpperCase()}`.slice(
    0,
    50,
  );
}

function deriveEmploymentStatus(member: AutomationGenVideoTeamMember): {
  employmentStatus: EmploymentStatus;
  leftAt: Date | null;
} {
  if (member.deleted_at) {
    return {
      employmentStatus: EmploymentStatus.LEFT,
      leftAt: new Date(member.deleted_at),
    };
  }
  if (!member.is_active) {
    return { employmentStatus: EmploymentStatus.INACTIVE, leftAt: null };
  }
  return { employmentStatus: EmploymentStatus.ACTIVE, leftAt: null };
}

function deriveJobTitle(
  member: AutomationGenVideoTeamMember,
  isTeamLeader: boolean,
): string {
  const fromSource = member.employee_position?.trim();
  if (fromSource) return fromSource.slice(0, 100);
  if (isTeamLeader) return 'Leader';
  if (member.is_content_creator) return 'Content Creator';
  return 'Editor';
}

function errorMessageOf(err: unknown): string {
  if (err instanceof AppException) {
    const response = err.getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      'message' in response
    ) {
      return String(response.message);
    }
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
