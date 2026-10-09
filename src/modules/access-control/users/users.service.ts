import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Prisma, ScopeType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import {
  paginate,
  toSkipTake,
  type PaginationQueryDto,
} from '../../../common/utils/pagination.dto';
import { PrismaService } from '../../../prisma/prisma.service';
import type { ResolvedScope } from '../../../common/types/resolved-scope.types';
import { buildEmployeeScopeWhere } from '../../../common/utils/employee-scope.util';
import { AuthorizationService } from '../authorization.service';
import type {
  CreateUserDto,
  SetUserRolesDto,
  UpdateUserDto,
  UserRoleAssignmentDto,
} from './dto/users.dto';

type ResolvedRoleAssignment = {
  roleId: number;
  scopeType: ScopeType;
  scopeTeamId: number | null;
};

const SYSTEM_ROLE_SCOPES: Readonly<Record<string, ScopeType>> = {
  ADMIN: ScopeType.ALL,
  HR: ScopeType.ALL,
  ACCOUNTANT: ScopeType.ALL,
  MANAGER_APPROVER: ScopeType.ALL,
  LEADER: ScopeType.TEAM,
  STAFF: ScopeType.SELF,
};

const ROLE_INCLUDE = {
  userRoles: {
    include: {
      role: { include: { rolePermissions: { include: { permission: true } } } },
    },
  },
  employee: { select: { id: true, employeeCode: true, fullName: true } },
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly authorization?: AuthorizationService,
  ) {}

  async list(query: PaginationQueryDto, actorUserId?: string) {
    const scope = await this.resolveManagementScope(actorUserId);
    const where = scope ? this.buildUserScopeWhere(scope, actorUserId!) : {};
    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: ROLE_INCLUDE,
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginate(
      data.map((user) => this.toSummary(user)),
      total,
      query.page,
      query.pageSize,
    );
  }

  private async getOrThrow(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: ROLE_INCLUDE,
    });
    if (!user) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy người dùng',
        HttpStatus.NOT_FOUND,
      );
    }
    return user;
  }

  async create(dto: CreateUserDto, actorUserId?: string) {
    const actorScope = await this.resolveManagementScope(actorUserId);
    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email.toLowerCase() },
    });
    if (existing) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Email đã tồn tại',
        HttpStatus.CONFLICT,
      );
    }

    const employee = dto.employeeId
      ? await this.assertEmployeeLinkable(dto.employeeId)
      : null;
    await this.assertEmployeeWithinManagementScope(
      dto.employeeId,
      actorScope,
      actorUserId,
    );

    if (dto.roles && dto.roles.length > 0) {
      await this.assertValidRoleAssignments(dto.roles);
      this.assertRoleAssignmentsWithinManagementScope(dto.roles, actorScope);
    }

    // Gán vai trò ngay lúc tạo để không còn bước "vào Phân quyền gán vai trò" tách rời:
    //  - roles gửi tường minh (kể cả []) → dùng đúng vậy.
    //  - không gửi roles + có nhân sự → suy mặc định theo vai trò mặc định của các nhóm nghiệp vụ
    //    với scope SELF. Nhân sự không có nhóm nào → [] (tài khoản không vai trò, FE cảnh báo).
    const roleAssignments =
      dto.roles !== undefined
        ? this.normalizeRoleAssignments(dto.roles)
        : this.deriveDefaultRoleAssignments(employee);

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email.toLowerCase(),
          passwordHash,
          fullName: employee?.fullName ?? displayNameFromEmail(dto.email),
          status: dto.status,
          employeeId: dto.employeeId,
        },
      });
      if (roleAssignments.length > 0) {
        await tx.userRole.createMany({
          data: roleAssignments.map((assignment) => ({
            userId: created.id,
            roleId: assignment.roleId,
            scopeType: assignment.scopeType,
            scopeTeamId: assignment.scopeTeamId,
          })),
        });
      }
      if (actorUserId) {
        await tx.auditLog.create({
          data: {
            actorUserId,
            action: 'USER_CREATED',
            entityType: 'User',
            entityId: created.id,
            afterData: {
              email: created.email,
              status: created.status,
              employeeId: created.employeeId,
              roles: roleAssignments,
            },
          },
        });
      }
      return tx.user.findUniqueOrThrow({
        where: { id: created.id },
        include: ROLE_INCLUDE,
      });
    });

    return this.toSummary(user);
  }

  async update(id: string, dto: UpdateUserDto, actorUserId?: string) {
    const actorScope = await this.resolveManagementScope(actorUserId);
    const existingUser = await this.getOrThrow(id);
    await this.assertUserWithinManagementScope(id, actorUserId, actorScope);

    if (
      dto.status !== undefined &&
      dto.status !== 'ACTIVE' &&
      existingUser.status === 'ACTIVE'
    ) {
      await this.assertNotLastActiveAdmin(existingUser);
    }

    if (dto.email) {
      const conflict = await this.prisma.user.findFirst({
        where: {
          id: { not: id },
          email: dto.email.toLowerCase(),
        },
      });
      if (conflict) {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Email đã tồn tại',
          HttpStatus.CONFLICT,
        );
      }
    }

    // employeeId: undefined (field không gửi) = giữ nguyên liên kết hiện tại (Prisma bỏ qua field
    // undefined trong `data`); null tường minh = gỡ liên kết; uuid = gắn/đổi (đã validate ở dưới).
    if (dto.employeeId) {
      await this.assertEmployeeLinkable(dto.employeeId, id);
    }
    if (dto.employeeId !== undefined) {
      await this.assertEmployeeWithinManagementScope(
        dto.employeeId ?? undefined,
        actorScope,
        actorUserId,
      );
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          email: dto.email?.toLowerCase(),
          fullName: dto.fullName,
          status: dto.status,
          employeeId: dto.employeeId,
          refreshTokenHash:
            dto.status && dto.status !== 'ACTIVE' ? null : undefined,
          refreshTokenExpiresAt:
            dto.status && dto.status !== 'ACTIVE' ? null : undefined,
        },
        include: ROLE_INCLUDE,
      });
      if (actorUserId) {
        await tx.auditLog.create({
          data: {
            actorUserId,
            action: 'USER_UPDATED',
            entityType: 'User',
            entityId: id,
            beforeData: {
              email: existingUser.email,
              fullName: existingUser.fullName,
              status: existingUser.status,
              employeeId: existingUser.employeeId,
            },
            afterData: {
              email: updated.email,
              fullName: updated.fullName,
              status: updated.status,
              employeeId: updated.employeeId,
            },
          },
        });
      }
      return updated;
    });

    return this.toSummary(user);
  }

  async setRoles(userId: string, dto: SetUserRolesDto, actorUserId?: string) {
    const actorScope = await this.resolveManagementScope(actorUserId);
    const existingUser = await this.getOrThrow(userId);
    await this.assertUserWithinManagementScope(userId, actorUserId, actorScope);
    await this.assertValidRoleAssignments(dto.roles);
    this.assertRoleAssignmentsWithinManagementScope(dto.roles, actorScope);
    const roleAssignments = this.normalizeRoleAssignments(dto.roles);

    const adminRole = existingUser.userRoles.find(
      ({ role }) => role.code === 'ADMIN',
    );
    if (
      adminRole &&
      !dto.roles.some(({ roleId }) => roleId === adminRole.roleId)
    ) {
      await this.assertNotLastActiveAdmin(existingUser);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({
        data: roleAssignments.map((assignment) => ({
          userId,
          roleId: assignment.roleId,
          scopeType: assignment.scopeType,
          scopeTeamId: assignment.scopeTeamId,
        })),
      });
      if (actorUserId) {
        await tx.auditLog.create({
          data: {
            actorUserId,
            action: 'USER_ROLES_UPDATED',
            entityType: 'User',
            entityId: userId,
            beforeData: {
              roles: existingUser.userRoles.map((assignment) => ({
                roleId: assignment.roleId,
                scopeType: assignment.scopeType,
                scopeTeamId: assignment.scopeTeamId,
              })),
            },
            afterData: {
              roles: roleAssignments,
            },
          },
        });
      }
    });

    const user = await this.getOrThrow(userId);
    return this.toSummary(user);
  }

  async getProfile(userId: string) {
    const user = await this.getOrThrow(userId);
    return this.toSummary(user);
  }

  /**
   * Scope của đúng permission `user.manage`. Không dùng scope tổng hợp theo resource để một role
   * khác không thể vô tình mở rộng quyền quản lý tài khoản.
   */
  private async resolveManagementScope(
    actorUserId?: string,
  ): Promise<ResolvedScope | null> {
    if (!actorUserId) return null;
    if (!this.authorization) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Không thể xác định phạm vi quản lý tài khoản',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.authorization.resolvePermissionScope(
      actorUserId,
      'user.manage',
    );
  }

  private buildUserScopeWhere(
    scope: ResolvedScope,
    actorUserId: string,
  ): Prisma.UserWhereInput {
    switch (scope.type) {
      case 'ALL':
        return {};
      case 'TEAM':
        return {
          employee: {
            is: buildEmployeeScopeWhere(scope, null),
          },
        };
      case 'SELF':
        return { id: actorUserId };
      case 'NONE':
      default:
        return { id: { in: [] } };
    }
  }

  private async assertUserWithinManagementScope(
    targetUserId: string,
    actorUserId: string | undefined,
    scope: ResolvedScope | null,
  ): Promise<void> {
    if (!scope || scope.type === 'ALL') return;
    const visible = await this.prisma.user.count({
      where: {
        AND: [
          { id: targetUserId },
          this.buildUserScopeWhere(scope, actorUserId!),
        ],
      },
    });
    if (visible === 0) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Tài khoản này không thuộc phạm vi quản lý của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async assertEmployeeWithinManagementScope(
    employeeId: number | undefined,
    scope: ResolvedScope | null,
    actorUserId?: string,
  ): Promise<void> {
    if (!scope || scope.type === 'ALL') return;
    if (!employeeId) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Tài khoản do phạm vi TEAM quản lý phải gắn với nhân sự thuộc team',
        HttpStatus.FORBIDDEN,
      );
    }

    const selfEmployeeId =
      scope.type === 'SELF' && actorUserId
        ? await this.authorization!.getEmployeeId(actorUserId)
        : null;
    const visible = await this.prisma.employee.count({
      where: {
        AND: [
          { id: employeeId },
          buildEmployeeScopeWhere(scope, selfEmployeeId),
        ],
      },
    });
    if (visible === 0) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Nhân sự được gắn không thuộc phạm vi quản lý của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertRoleAssignmentsWithinManagementScope(
    roles: readonly UserRoleAssignmentDto[],
    scope: ResolvedScope | null,
  ): void {
    if (!scope || scope.type === 'ALL') return;

    const outsideScope = roles.some((assignment) => {
      if (scope.type === 'NONE') return true;
      if (assignment.scopeType === ScopeType.ALL) return true;
      if (assignment.scopeType === ScopeType.SELF) return false;
      return (
        scope.type !== 'TEAM' ||
        assignment.scopeTeamId == null ||
        !scope.teamIds.includes(assignment.scopeTeamId)
      );
    });
    if (outsideScope) {
      throw new AppException(
        ErrorCode.OUT_OF_SCOPE,
        'Không thể gán vai trò vượt ngoài phạm vi quản lý của bạn',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Nhân sự phải tồn tại và chưa gắn tài khoản nào khác (unique employeeId ở DB — kiểm trước để
   * trả lỗi CONFLICT dễ hiểu thay vì để lộ lỗi ràng buộc unique thô từ Prisma). */
  private async assertEmployeeLinkable(
    employeeId: number,
    excludeUserId?: string,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: {
        employeeGroups: {
          select: { employeeGroup: { select: { defaultRoleId: true } } },
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

    const linkedToOther = await this.prisma.user.findFirst({
      where: {
        employeeId,
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
    });
    if (linkedToOther) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Nhân sự này đã được gắn với một tài khoản khác',
        HttpStatus.CONFLICT,
      );
    }

    return employee;
  }

  /** Validate danh sách gán vai trò (scope hợp lệ + role tồn tại). Dùng chung cho create & setRoles. */
  private async assertValidRoleAssignments(roles: UserRoleAssignmentDto[]) {
    this.assertRoleAssignmentShape(roles);

    const roleIds = [...new Set(roles.map((assignment) => assignment.roleId))];
    if (roleIds.length === 0) {
      return;
    }
    const teamIds = [
      ...new Set(
        roles.flatMap((assignment) =>
          assignment.scopeType === ScopeType.TEAM &&
          assignment.scopeTeamId != null
            ? [assignment.scopeTeamId]
            : [],
        ),
      ),
    ];
    const [found, teamCount] = await Promise.all([
      this.prisma.role.findMany({ where: { id: { in: roleIds } } }),
      teamIds.length > 0
        ? this.prisma.team.count({ where: { id: { in: teamIds } } })
        : Promise.resolve(0),
    ]);
    const missing = roleIds.filter(
      (id) => !found.some((role) => role.id === id),
    );
    if (missing.length > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Có roleId không tồn tại',
        HttpStatus.BAD_REQUEST,
        { unknownRoleIds: missing },
      );
    }
    const rolesById = new Map(found.map((role) => [role.id, role]));
    for (const assignment of roles) {
      const role = rolesById.get(assignment.roleId);
      if (role) this.assertSystemRoleScope(role.code, assignment.scopeType);
    }
    if (teamCount !== teamIds.length) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Có scopeTeamId không tồn tại',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private assertRoleAssignmentShape(
    roles: readonly UserRoleAssignmentDto[],
  ): void {
    const assignmentKeys = new Set<string>();

    for (const assignment of roles) {
      if (
        assignment.scopeType === ScopeType.TEAM &&
        assignment.scopeTeamId == null
      ) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'scope_type=TEAM bắt buộc phải có scopeTeamId',
          HttpStatus.BAD_REQUEST,
        );
      }
      if (
        assignment.scopeType !== ScopeType.TEAM &&
        assignment.scopeTeamId != null
      ) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'scopeTeamId chỉ áp dụng khi scope_type=TEAM',
          HttpStatus.BAD_REQUEST,
        );
      }

      const key = `${assignment.roleId}:${assignment.scopeType}:${assignment.scopeTeamId ?? ''}`;
      if (assignmentKeys.has(key)) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Danh sách vai trò có mục bị trùng',
          HttpStatus.BAD_REQUEST,
        );
      }
      assignmentKeys.add(key);
    }
  }

  private normalizeRoleAssignments(
    roles: readonly UserRoleAssignmentDto[],
  ): ResolvedRoleAssignment[] {
    return roles.map((assignment) => ({
      roleId: assignment.roleId,
      scopeType: assignment.scopeType,
      scopeTeamId:
        assignment.scopeType === ScopeType.TEAM
          ? (assignment.scopeTeamId ?? null)
          : null,
    }));
  }

  private deriveDefaultRoleAssignments(
    employee: {
      employeeGroups: { employeeGroup: { defaultRoleId: number | null } }[];
    } | null,
  ): ResolvedRoleAssignment[] {
    const roleIds = new Set(
      employee?.employeeGroups
        .map((link) => link.employeeGroup.defaultRoleId)
        .filter((roleId): roleId is number => roleId !== null) ?? [],
    );

    return [...roleIds].map((roleId) => ({
      roleId,
      scopeType: ScopeType.SELF,
      scopeTeamId: null,
    }));
  }

  private assertSystemRoleScope(roleCode: string, scopeType: ScopeType): void {
    const requiredScope = SYSTEM_ROLE_SCOPES[roleCode];
    if (requiredScope && scopeType !== requiredScope) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Vai trò hệ thống ${roleCode} bắt buộc dùng phạm vi ${requiredScope}`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertNotLastActiveAdmin(
    user: Awaited<ReturnType<UsersService['getOrThrow']>>,
  ) {
    if (
      user.status !== 'ACTIVE' ||
      !user.userRoles.some(({ role }) => role.code === 'ADMIN')
    ) {
      return;
    }
    const otherActiveAdmins = await this.prisma.user.count({
      where: {
        id: { not: user.id },
        status: 'ACTIVE',
        userRoles: { some: { role: { code: 'ADMIN' } } },
      },
    });
    if (otherActiveAdmins === 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Không thể khóa hoặc gỡ quyền của quản trị viên hoạt động cuối cùng',
        HttpStatus.CONFLICT,
      );
    }
  }

  private toSummary(user: Awaited<ReturnType<UsersService['getOrThrow']>>) {
    const permissions = new Set<string>();
    for (const userRole of user.userRoles) {
      for (const rolePermission of userRole.role.rolePermissions) {
        permissions.add(rolePermission.permission.code);
      }
    }

    return {
      id: user.id,
      // employeeId: nhân sự liên kết với tài khoản này (null nếu tài khoản thuần hệ thống, vd.
      // Admin/HR không gắn hồ sơ nhân sự) — FE dùng để biết "đây có phải hồ sơ của chính mình"
      // (vd. M07 KPI: self-confirm vs leader-approve).
      employeeId: user.employeeId,
      // Rút gọn của nhân sự liên kết (null nếu chưa gắn) — để trang quản lý tài khoản hiển thị
      // tên/mã nhân sự thay vì chỉ UUID thô.
      employee: user.employee,
      email: user.email,
      fullName: user.fullName,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      roles: user.userRoles.map((userRole) => ({
        roleId: userRole.roleId,
        roleCode: userRole.role.code,
        roleName: userRole.role.name,
        scopeType: userRole.scopeType,
        scopeTeamId: userRole.scopeTeamId,
      })),
      permissions: [...permissions],
    };
  }
}

function displayNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] ?? email;
  const words = localPart.split(/[._-]+/).filter(Boolean);
  const displayName = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return (displayName || localPart).slice(0, 200);
}
