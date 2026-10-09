import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { EmployeeGroupStatus, EmploymentStatus, Prisma } from '@prisma/client';
import { AuthorizationService } from '../../access-control/authorization.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { paginate, toSkipTake } from '../../../common/utils/pagination.dto';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  CreateEmployeeDto,
  UpdateEmployeeDto,
  UpsertEmployeeTeamMembershipDto,
} from './dto/employee.dto';
import type { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import {
  assertEmployeeGroupsAssignable,
  normalizeJobTitle,
  withFlatEmployeeGroups,
} from '../../../common/utils/employee-group.util';
import {
  createJoinRows,
  replaceJoinRows,
} from '../../../common/utils/join-table.util';
import { buildEmployeeScopeWhere } from '../../../common/utils/employee-scope.util';
import { AuditLogService } from '../../audit/audit-log.service';

// Nhóm nghiệp vụ trả kèm nhân sự: FE hiển thị badge + form sửa cần đúng bộ id/tên này.
const EMPLOYEE_GROUP_SELECT = {
  select: {
    employeeGroup: {
      select: {
        id: true,
        code: true,
        name: true,
        departmentId: true,
        // FE trang Phân quyền gợi ý sẵn vai trò mặc định theo nhóm, giống hệt logic BE khi tạo tài khoản.
        defaultRoleId: true,
      },
    },
  },
  orderBy: { employeeGroup: { name: 'asc' } },
} as const;

const TEAM_MEMBERSHIP_INCLUDE = {
  where: { isActive: true },
  include: {
    team: { include: { department: true } },
    leader: { select: { id: true, employeeCode: true, fullName: true } },
    manager: { select: { id: true, employeeCode: true, fullName: true } },
  },
  orderBy: [{ isPrimary: 'desc' }, { team: { name: 'asc' } }],
} satisfies Prisma.Employee$teamMembershipsArgs;

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  async list(userId: string, query: ListEmployeesQueryDto) {
    const scope = await this.authorization.resolveScope(userId, 'employee');
    const selfEmployeeId =
      scope.type === 'SELF'
        ? await this.authorization.getEmployeeId(userId)
        : null;

    const where: Prisma.EmployeeWhereInput = {
      AND: [
        buildEmployeeScopeWhere(scope, selfEmployeeId),
        this.buildFilterWhere(query),
      ],
    };

    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const [data, total] = await Promise.all([
      this.prisma.employee.findMany({
        where,
        skip,
        take,
        orderBy: { fullName: 'asc' },
        // user: tài khoản đăng nhập đã gắn với nhân sự này (null nếu chưa gắn) — để FE trang Nhân
        // sự biết ngay trạng thái tài khoản mà không cần gọi thêm API.
        include: {
          team: { include: { department: true } },
          teamMemberships: TEAM_MEMBERSHIP_INCLUDE,
          externalIdentities: {
            select: {
              sourceSystem: true,
              externalUserId: true,
              externalEmployeeCode: true,
              lastKnownEmail: true,
            },
          },
          employeeGroups: EMPLOYEE_GROUP_SELECT,
          user: {
            select: { id: true, email: true, status: true },
          },
        },
      }),
      this.prisma.employee.count({ where }),
    ]);

    return paginate(
      data.map(withFlatEmployeeGroups),
      total,
      query.page,
      query.pageSize,
    );
  }

  async getOne(userId: string, id: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        team: { include: { department: true } },
        teamMemberships: TEAM_MEMBERSHIP_INCLUDE,
        externalIdentities: {
          select: {
            sourceSystem: true,
            externalUserId: true,
            externalEmployeeCode: true,
            lastKnownEmail: true,
          },
        },
        employeeGroups: EMPLOYEE_GROUP_SELECT,
        user: {
          select: { id: true, email: true, status: true },
        },
      },
    });
    if (!employee) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhân sự',
        HttpStatus.NOT_FOUND,
      );
    }

    const scope = await this.authorization.resolveScope(userId, 'employee');
    const visible = await this.isVisible(
      userId,
      scope,
      employee.id,
      employee.teamId,
    );
    if (!visible) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự này không nằm trong phạm vi dữ liệu của bạn',
        HttpStatus.FORBIDDEN,
      );
    }

    return withFlatEmployeeGroups(employee);
  }

  async create(dto: CreateEmployeeDto, actorUserId?: string) {
    const team = await this.assertTeamExists(dto.teamId);
    await this.assertHierarchyValid(
      undefined,
      dto.leaderEmployeeId,
      dto.managerEmployeeId,
    );
    const groups = dto.employeeGroupIds
      ? await this.assertGroupsAssignable(
          dto.employeeGroupIds,
          team.departmentId,
        )
      : null;
    const employeeGroupIds = groups
      ? groups.map((group) => group.id)
      : dto.jobTitle
        ? await this.inferEmployeeGroupIds(dto.jobTitle, team.departmentId)
        : [];
    const latest = await this.prisma.employee.aggregate({ _max: { id: true } });
    const employeeCode = `NV-${String((latest._max.id ?? 0) + 1).padStart(6, '0')}`;

    const data: Prisma.EmployeeCreateInput = {
      employeeCode,
      fullName: dto.fullName,
      jobTitle: dto.jobTitle ?? jobTitleFromGroups(groups ?? []),
      employeeGroups: createJoinRows('employeeGroupId', employeeGroupIds),
      team: { connect: { id: dto.teamId } },
      teamMemberships: {
        create: {
          teamId: dto.teamId,
          isPrimary: true,
          defaultSalaryWeightPercent: 100,
          leaderEmployeeId: dto.leaderEmployeeId,
          managerEmployeeId: dto.managerEmployeeId,
          joinedAt: dto.joinedAt ? new Date(dto.joinedAt) : undefined,
        },
      },
      leader: dto.leaderEmployeeId
        ? { connect: { id: dto.leaderEmployeeId } }
        : undefined,
      manager: dto.managerEmployeeId
        ? { connect: { id: dto.managerEmployeeId } }
        : undefined,
      employmentStatus: dto.employmentStatus,
      joinedAt: dto.joinedAt ? new Date(dto.joinedAt) : undefined,
    };
    const create = async (db: PrismaService | Prisma.TransactionClient) =>
      withFlatEmployeeGroups(
        await db.employee.create({
          data,
          include: { employeeGroups: EMPLOYEE_GROUP_SELECT },
        }),
      );
    if (!actorUserId || !this.auditLog) return create(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      const created = await create(tx);
      await this.auditLog!.record(tx, {
        actorUserId,
        action: 'EMPLOYEE_CREATED',
        entityType: 'Employee',
        entityId: created.id,
        targetEmployeeId: created.id,
        afterData: employeeAuditSnapshot(created),
      });
      return created;
    });
  }

  async update(id: number, dto: UpdateEmployeeDto, actorUserId?: string) {
    const existing = await this.getOrThrow(id);

    const team = dto.teamId
      ? await this.assertTeamExists(dto.teamId)
      : existing.team;
    // Đổi chức danh mà không gửi nhóm tường minh thì đoán lại theo chức danh mới — giữ nguyên
    // hành vi cũ. Danh mục nhóm được lọc theo phòng ban của team (mới, nếu có đổi team).
    const groups = dto.employeeGroupIds
      ? await this.assertGroupsAssignable(
          dto.employeeGroupIds,
          team.departmentId,
          existing.employeeGroups.map((group) => group.id),
        )
      : null;
    const employeeGroupIds = groups
      ? groups.map((group) => group.id)
      : dto.jobTitle
        ? await this.inferEmployeeGroupIds(dto.jobTitle, team.departmentId)
        : null;
    // Nhân sự tạo tay lấy chức danh theo nhóm nên đổi nhóm thì đổi theo; nhân sự đồng bộ giữ
    // chức danh VCBI cấp (vd "Leader") vì nhóm không thể hiện được vai trò đó.
    const jobTitle =
      dto.jobTitle ??
      (groups && !existing.sourceSystem
        ? jobTitleFromGroups(groups)
        : undefined);
    await this.assertHierarchyValid(
      id,
      dto.leaderEmployeeId,
      dto.managerEmployeeId,
    );

    let leftAt: Date | null | undefined;
    if (dto.leftAt !== undefined) {
      leftAt = dto.leftAt === null ? null : new Date(dto.leftAt);
    } else if (
      dto.employmentStatus === EmploymentStatus.LEFT &&
      existing.employmentStatus !== EmploymentStatus.LEFT
    ) {
      leftAt = new Date();
    } else if (
      dto.employmentStatus !== undefined &&
      dto.employmentStatus !== EmploymentStatus.LEFT
    ) {
      leftAt = null;
    }

    const update = async (db: PrismaService | Prisma.TransactionClient) => {
      const updated = await db.employee.update({
        where: { id },
        data: {
          fullName: dto.fullName,
          jobTitle,
          employeeGroups: employeeGroupIds
            ? replaceJoinRows('employeeGroupId', employeeGroupIds)
            : undefined,
          teamId: dto.teamId,
          leaderEmployeeId: dto.leaderEmployeeId,
          managerEmployeeId: dto.managerEmployeeId,
          employmentStatus: dto.employmentStatus,
          joinedAt:
            dto.joinedAt === null
              ? null
              : dto.joinedAt
                ? new Date(dto.joinedAt)
                : undefined,
          leftAt,
        },
        include: { employeeGroups: EMPLOYEE_GROUP_SELECT },
      });
      if (dto.teamId) {
        await db.employeeTeamMembership.updateMany({
          where: {
            employeeId: id,
            isPrimary: true,
            teamId: { not: dto.teamId },
          },
          data: { isPrimary: false, defaultSalaryWeightPercent: 0 },
        });
        const primaryMembership = await db.employeeTeamMembership.upsert({
          where: { employeeId_teamId: { employeeId: id, teamId: dto.teamId } },
          update: {
            isPrimary: true,
            isActive: true,
            leftAt: null,
            defaultSalaryWeightPercent: 100,
            leaderEmployeeId: dto.leaderEmployeeId,
            managerEmployeeId: dto.managerEmployeeId,
          },
          create: {
            employeeId: id,
            teamId: dto.teamId,
            isPrimary: true,
            defaultSalaryWeightPercent: 100,
            leaderEmployeeId: dto.leaderEmployeeId,
            managerEmployeeId: dto.managerEmployeeId,
          },
        });
        // Team chính mới nhận 100% nhưng nhân sự có thể còn team phụ đang giữ tỷ trọng riêng —
        // trừ lại phần đó để tổng không vọt lên trên 100%.
        await this.rebalanceToPrimary(db, id, primaryMembership.id);
      }
      return withFlatEmployeeGroups(updated);
    };
    if (!actorUserId || !this.auditLog) return update(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      const updated = await update(tx);
      await this.auditLog!.record(tx, {
        actorUserId,
        action: 'EMPLOYEE_UPDATED',
        entityType: 'Employee',
        entityId: id,
        targetEmployeeId: id,
        beforeData: employeeAuditSnapshot(existing),
        afterData: employeeAuditSnapshot(updated),
      });
      return updated;
    });
  }

  async upsertMembership(
    employeeId: number,
    dto: UpsertEmployeeTeamMembershipDto,
    actorUserId: string,
  ) {
    const [employee] = await Promise.all([
      this.getOrThrow(employeeId),
      this.assertTeamExists(dto.teamId),
    ]);
    await this.assertHierarchyValid(
      employeeId,
      dto.leaderEmployeeId,
      dto.managerEmployeeId,
    );

    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.employeeTeamMembership.updateMany({
          where: { employeeId, isPrimary: true, teamId: { not: dto.teamId } },
          data: { isPrimary: false },
        });
      }
      const membership = await tx.employeeTeamMembership.upsert({
        where: { employeeId_teamId: { employeeId, teamId: dto.teamId } },
        update: {
          isPrimary: dto.isPrimary,
          defaultSalaryWeightPercent: dto.salaryWeightPercent,
          leaderEmployeeId: dto.leaderEmployeeId,
          managerEmployeeId: dto.managerEmployeeId,
          joinedAt:
            dto.joinedAt === null
              ? null
              : dto.joinedAt
                ? new Date(dto.joinedAt)
                : undefined,
          leftAt: null,
          isActive: true,
        },
        create: {
          employeeId,
          teamId: dto.teamId,
          isPrimary: dto.isPrimary ?? false,
          defaultSalaryWeightPercent: dto.salaryWeightPercent,
          leaderEmployeeId: dto.leaderEmployeeId,
          managerEmployeeId: dto.managerEmployeeId,
          joinedAt: dto.joinedAt ? new Date(dto.joinedAt) : undefined,
          isActive: true,
        },
        include: { team: true },
      });

      const activeMemberships = await tx.employeeTeamMembership.findMany({
        where: { employeeId, isActive: true },
        select: {
          teamId: true,
          isPrimary: true,
          defaultSalaryWeightPercent: true,
        },
      });
      const totalWeight = activeMemberships.reduce(
        (sum, item) => sum.plus(item.defaultSalaryWeightPercent),
        new Prisma.Decimal(0),
      );
      if (totalWeight.gt(100)) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Tổng tỷ trọng KPI của các team không được vượt quá 100%',
          HttpStatus.BAD_REQUEST,
          { totalWeightPercent: totalWeight.toString() },
        );
      }

      if (membership.isPrimary) {
        await tx.employee.update({
          where: { id: employeeId },
          data: {
            teamId: membership.teamId,
            leaderEmployeeId: membership.leaderEmployeeId,
            managerEmployeeId: membership.managerEmployeeId,
          },
        });
      } else if (!activeMemberships.some((item) => item.isPrimary)) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Nhân sự phải có đúng một team chính',
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.auditLog?.record(tx, {
        actorUserId,
        action: 'EMPLOYEE_TEAM_MEMBERSHIP_UPSERTED',
        entityType: 'EmployeeTeamMembership',
        entityId: membership.id,
        targetEmployeeId: employeeId,
        beforeData: { primaryTeamId: employee.teamId },
        afterData: {
          teamId: membership.teamId,
          isPrimary: membership.isPrimary,
          salaryWeightPercent: membership.defaultSalaryWeightPercent.toString(),
          totalWeightPercent: totalWeight.toString(),
        },
      });
      return membership;
    });
  }

  async deactivateMembership(
    employeeId: number,
    teamId: number,
    actorUserId: string,
  ) {
    await this.getOrThrow(employeeId);
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.employeeTeamMembership.findUnique({
        where: { employeeId_teamId: { employeeId, teamId } },
      });
      if (!membership || !membership.isActive) {
        throw new AppException(
          ErrorCode.NOT_FOUND,
          'Không tìm thấy membership đang hoạt động',
          HttpStatus.NOT_FOUND,
        );
      }
      const alternatives = await tx.employeeTeamMembership.findMany({
        where: { employeeId, isActive: true, teamId: { not: teamId } },
        orderBy: [{ defaultSalaryWeightPercent: 'desc' }, { id: 'asc' }],
      });
      if (alternatives.length === 0) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Không thể xóa team hoạt động cuối cùng của nhân sự',
          HttpStatus.BAD_REQUEST,
        );
      }
      await tx.employeeTeamMembership.update({
        where: { id: membership.id },
        data: {
          isActive: false,
          isPrimary: false,
          leftAt: new Date(),
          defaultSalaryWeightPercent: 0,
        },
      });
      // Gỡ team chính thì team nặng nhất còn lại lên thay; gỡ team phụ thì giữ nguyên team chính
      // hiện có (fallback về team nặng nhất nếu dữ liệu cũ không có team chính nào).
      const primary = membership.isPrimary
        ? alternatives[0]
        : (alternatives.find((item) => item.isPrimary) ?? alternatives[0]);
      const primaryWeight = await this.rebalanceToPrimary(
        tx,
        employeeId,
        primary.id,
      );
      if (!primary.isPrimary) {
        await tx.employee.update({
          where: { id: employeeId },
          data: {
            teamId: primary.teamId,
            leaderEmployeeId: primary.leaderEmployeeId,
            managerEmployeeId: primary.managerEmployeeId,
          },
        });
      }
      await this.auditLog?.record(tx, {
        actorUserId,
        action: 'EMPLOYEE_TEAM_MEMBERSHIP_DEACTIVATED',
        entityType: 'EmployeeTeamMembership',
        entityId: membership.id,
        targetEmployeeId: employeeId,
        beforeData: {
          teamId,
          isPrimary: membership.isPrimary,
          salaryWeightPercent: String(membership.defaultSalaryWeightPercent),
        },
        afterData: {
          isActive: false,
          primaryTeamId: primary.teamId,
          primaryWeightPercent: primaryWeight.toString(),
        },
      });
      return { success: true };
    });
  }

  /**
   * Bất biến dữ liệu tổ chức: mỗi nhân sự có đúng 1 team chính và tổng tỷ trọng KPI đúng 100%.
   * Mọi thao tác làm đổi danh sách team phải gọi hàm này để team chính "hấp thụ" phần thiếu/dư —
   * nếu không, tổng tỷ trọng lệch khỏi 100% và kỳ lương không mở được (assertMembershipWeights
   * bên payroll-periods chặn snapshot). Hàm cũng tự chuẩn hoá dữ liệu cũ đã bị lệch.
   */
  private async rebalanceToPrimary(
    db: PrismaService | Prisma.TransactionClient,
    employeeId: number,
    primaryMembershipId: number,
  ) {
    const others = await db.employeeTeamMembership.findMany({
      where: {
        employeeId,
        isActive: true,
        id: { not: primaryMembershipId },
      },
      select: { defaultSalaryWeightPercent: true },
    });
    const othersWeight = others.reduce(
      (sum, item) => sum.plus(item.defaultSalaryWeightPercent),
      new Prisma.Decimal(0),
    );
    // Các team phụ vượt quá 100% chỉ có thể đến từ dữ liệu cũ/đồng bộ ngoài: kẹp về 0 thay vì
    // ghi số âm, phần lệch còn lại sẽ hiện ở màn kiểm tra trước khi mở kỳ.
    const primaryWeight = Prisma.Decimal.max(
      new Prisma.Decimal(100).minus(othersWeight),
      0,
    );
    await db.employeeTeamMembership.update({
      where: { id: primaryMembershipId },
      data: { isPrimary: true, defaultSalaryWeightPercent: primaryWeight },
    });
    return primaryWeight;
  }

  private async getOrThrow(id: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        team: true,
        employeeGroups: { select: { employeeGroup: { select: { id: true } } } },
      },
    });
    if (!employee) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhân sự',
        HttpStatus.NOT_FOUND,
      );
    }
    return withFlatEmployeeGroups(employee);
  }

  private async isVisible(
    userId: string,
    scope: Awaited<ReturnType<AuthorizationService['resolveScope']>>,
    employeeId: number,
    teamId: number,
  ) {
    if (scope.type === 'ALL') return true;
    if (scope.type === 'TEAM') {
      if (scope.teamIds.includes(teamId)) return true;
      if (!this.prisma.employeeTeamMembership?.count) return false;
      const count = await this.prisma.employeeTeamMembership.count({
        where: { employeeId, teamId: { in: scope.teamIds }, isActive: true },
      });
      return count > 0;
    }
    if (scope.type === 'SELF') {
      const selfEmployeeId = await this.authorization.getEmployeeId(userId);
      return selfEmployeeId === employeeId;
    }
    return false;
  }

  private buildFilterWhere(
    query: ListEmployeesQueryDto,
  ): Prisma.EmployeeWhereInput {
    return {
      ...(query.teamId
        ? {
            OR: [
              { teamId: query.teamId },
              {
                teamMemberships: {
                  some: { teamId: query.teamId, isActive: true },
                },
              },
            ],
          }
        : {}),
      // `excludeLeft` chỉ là lối tắt cho "còn làm việc"; lọc theo đúng một trạng thái cụ thể vẫn
      // được ưu tiên khi FE truyền cả hai.
      employmentStatus:
        query.employmentStatus ??
        (query.excludeLeft ? { not: EmploymentStatus.LEFT } : undefined),
      leaderEmployeeId: query.leaderEmployeeId,
      managerEmployeeId: query.managerEmployeeId,
      jobTitle: query.jobTitle
        ? { contains: query.jobTitle, mode: 'insensitive' }
        : undefined,
      OR: query.search
        ? [
            { fullName: { contains: query.search, mode: 'insensitive' } },
            { employeeCode: { contains: query.search, mode: 'insensitive' } },
          ]
        : undefined,
    };
  }

  private async assertTeamExists(teamId: number) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'teamId không tồn tại',
        HttpStatus.BAD_REQUEST,
      );
    }
    return team;
  }

  private async assertGroupsAssignable(
    groupIds: number[],
    departmentId: number,
    alreadyAssignedIds: number[] = [],
  ) {
    return assertEmployeeGroupsAssignable(
      this.prisma,
      groupIds,
      [departmentId],
      alreadyAssignedIds,
    );
  }

  /**
   * Đoán nhóm nghiệp vụ từ chức danh bằng từ khóa khai trong danh mục — chỉ xét nhóm ACTIVE của
   * đúng phòng ban đó (hoặc nhóm dùng chung), để chức danh trùng từ khóa của phòng ban khác không
   * kéo nhầm nhóm vào.
   */
  private async inferEmployeeGroupIds(jobTitle: string, departmentId: number) {
    const normalized = normalizeJobTitle(jobTitle);
    const candidates = await this.prisma.employeeGroup.findMany({
      where: {
        status: EmployeeGroupStatus.ACTIVE,
        OR: [{ departmentId }, { departmentId: null }],
      },
      select: { id: true, jobTitleKeywords: true },
    });
    return candidates
      .filter((group) =>
        group.jobTitleKeywords.some((keyword) => normalized.includes(keyword)),
      )
      .map((group) => group.id);
  }

  private async assertHierarchyValid(
    selfId: number | undefined,
    leaderEmployeeId: number | null | undefined,
    managerEmployeeId: number | null | undefined,
  ) {
    if (selfId && leaderEmployeeId === selfId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự không thể là leader của chính mình',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (selfId && managerEmployeeId === selfId) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nhân sự không thể là manager của chính mình',
        HttpStatus.BAD_REQUEST,
      );
    }

    const idsToCheck = [leaderEmployeeId, managerEmployeeId].filter(
      (value): value is number => Boolean(value),
    );
    if (idsToCheck.length === 0) return;

    const found = await this.prisma.employee.findMany({
      where: { id: { in: idsToCheck } },
      select: { id: true },
    });
    const missing = idsToCheck.filter(
      (id) => !found.some((employee) => employee.id === id),
    );
    if (missing.length > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'leaderEmployeeId hoặc managerEmployeeId không tồn tại',
        HttpStatus.BAD_REQUEST,
        { unknownIds: missing },
      );
    }
  }
}

/** Chức danh hiển thị khi không nhập tay: tên các nhóm nghiệp vụ, xếp theo thứ tự tạo nhóm. */
function jobTitleFromGroups(groups: Array<{ id: number; name: string }>) {
  if (groups.length === 0) return 'Chưa phân nhóm';
  return [...groups]
    .sort((a, b) => a.id - b.id)
    .map((group) => group.name)
    .join(', ')
    .slice(0, 100);
}

function employeeAuditSnapshot(employee: {
  employeeCode?: string;
  fullName?: string;
  jobTitle?: string;
  teamId?: number;
  leaderEmployeeId?: number | null;
  managerEmployeeId?: number | null;
  employmentStatus?: EmploymentStatus;
  joinedAt?: Date | null;
  leftAt?: Date | null;
  employeeGroups?: Array<{ id: number }>;
}): Prisma.InputJsonObject {
  return {
    employeeCode: employee.employeeCode ?? null,
    fullName: employee.fullName ?? null,
    jobTitle: employee.jobTitle ?? null,
    teamId: employee.teamId ?? null,
    leaderEmployeeId: employee.leaderEmployeeId ?? null,
    managerEmployeeId: employee.managerEmployeeId ?? null,
    employmentStatus: employee.employmentStatus ?? null,
    joinedAt: employee.joinedAt?.toISOString() ?? null,
    leftAt: employee.leftAt?.toISOString() ?? null,
    employeeGroupIds: employee.employeeGroups?.map((group) => group.id) ?? [],
  };
}
