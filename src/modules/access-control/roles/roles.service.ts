import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  CreateRoleDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from './dto/roles.dto';

const FULL_ACCESS_ROLE_CODES = new Set(['ADMIN', 'MANAGER_APPROVER']);

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.role.findMany({
      include: { rolePermissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
  }

  private async getOrThrow(id: number) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy vai trò',
        HttpStatus.NOT_FOUND,
      );
    }
    return role;
  }

  async create(dto: CreateRoleDto, actorUserId?: string) {
    const code = `ROLE_${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          code,
          name: dto.name,
          description: dto.description,
          isSystemRole: false,
        },
      });
      if (actorUserId) {
        await tx.auditLog.create({
          data: {
            actorUserId,
            action: 'ROLE_CREATED',
            entityType: 'Role',
            entityId: String(role.id),
            afterData: { code, name: role.name },
          },
        });
      }
      return role;
    });
  }

  async update(id: number, dto: UpdateRoleDto, actorUserId?: string) {
    const existing = await this.getOrThrow(id);
    if (existing.isSystemRole) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Không thể đổi thông tin định danh của vai trò hệ thống',
        HttpStatus.FORBIDDEN,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.role.update({
        where: { id },
        data: { name: dto.name, description: dto.description },
      });
      if (actorUserId) {
        await tx.auditLog.create({
          data: {
            actorUserId,
            action: 'ROLE_UPDATED',
            entityType: 'Role',
            entityId: String(id),
            beforeData: {
              name: existing.name,
              description: existing.description,
            },
            afterData: {
              name: updated.name,
              description: updated.description,
            },
          },
        });
      }
      return updated;
    });
  }

  async setPermissions(
    roleId: number,
    dto: SetRolePermissionsDto,
    actorUserId?: string,
  ) {
    const role = await this.getOrThrow(roleId);

    const permissions = await this.prisma.permission.findMany({
      where: { code: { in: dto.permissionCodes } },
    });

    const missing = dto.permissionCodes.filter(
      (code) => !permissions.some((permission) => permission.code === code),
    );
    if (missing.length > 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Có mã quyền không tồn tại',
        HttpStatus.BAD_REQUEST,
        { unknownCodes: missing },
      );
    }

    const requestedCodes = new Set(dto.permissionCodes);
    if (requestedCodes.has('revenue.write') && role.code !== 'ACCOUNTANT') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'revenue.write chỉ được phép gán cho vai trò Kế toán',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (role.code === 'ACCOUNTANT' && !requestedCodes.has('revenue.write')) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Vai trò Kế toán bắt buộc phải giữ quyền revenue.write',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (FULL_ACCESS_ROLE_CODES.has(role.code)) {
      const adminRequiredCodes = (
        await this.prisma.permission.findMany({
          where: { code: { not: 'revenue.write' } },
          select: { code: true },
        })
      ).map(({ code }) => code);
      const missingAdminCodes = adminRequiredCodes.filter(
        (code) => !requestedCodes.has(code),
      );
      if (missingAdminCodes.length > 0) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Vai trò toàn quyền phải giữ toàn bộ quyền quản trị bắt buộc',
          HttpStatus.BAD_REQUEST,
          { missingPermissionCodes: missingAdminCodes },
        );
      }
    }

    const before = await this.prisma.rolePermission.findMany({
      where: { roleId },
      include: { permission: true },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await tx.rolePermission.createMany({
        data: permissions.map((permission) => ({
          roleId,
          permissionId: permission.id,
        })),
      });
      if (actorUserId) {
        await tx.auditLog.create({
          data: {
            actorUserId,
            action: 'ROLE_PERMISSIONS_UPDATED',
            entityType: 'Role',
            entityId: String(roleId),
            beforeData: {
              permissionCodes: before.map(({ permission }) => permission.code),
            },
            afterData: { permissionCodes: dto.permissionCodes },
          },
        });
      }
    });

    return this.prisma.role.findUnique({
      where: { id: roleId },
      include: { rolePermissions: { include: { permission: true } } },
    });
  }
}
