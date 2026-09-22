import { HttpStatus, Injectable } from '@nestjs/common';
import { ScopeType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import {
  paginate,
  toSkipTake,
  type PaginationQueryDto,
} from '../../../common/utils/pagination.dto';
import { PrismaService } from '../../../prisma/prisma.service';
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
  EDITOR: ScopeType.SELF,
  CONTENT_CREATOR: ScopeType.SELF,
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
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PaginationQueryDto) {
    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: ROLE_INCLUDE,
      }),
      this.prisma.user.count(),
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

    if (dto.roles && dto.roles.length > 0) {
      await this.assertValidRoleAssignments(dto.roles);
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
    const existingUser = await this.getOrThrow(id);

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
    const existingUser = await this.getOrThrow(userId);
    await this.assertValidRoleAssignments(dto.roles);
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

  /** Nhân sự phải tồn tại và chưa gắn tài khoản nào khác (unique employeeId ở DB — kiểm trước để
   * trả lỗi CONFLICT dễ hiểu thay vì để lộ lỗi ràng buộc unique thô từ Prisma). */
  private async assertEmployeeLinkable(
    employeeId: number,
    excludeUserId?: string,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: { employeeGroups: { select: { defaultRoleId: true } } },
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
    employee: { employeeGroups: { defaultRoleId: number | null }[] } | null,
  ): ResolvedRoleAssignment[] {
    const roleIds = new Set(
      employee?.employeeGroups
        .map((group) => group.defaultRoleId)
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
