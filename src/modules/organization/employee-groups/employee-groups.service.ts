import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  CreateEmployeeGroupDto,
  ListEmployeeGroupsQueryDto,
  UpdateEmployeeGroupDto,
} from './dto/employee-group.dto';
import { normalizeJobTitle } from './employee-group.util';

const GROUP_INCLUDE = {
  department: true,
  defaultRole: { select: { id: true, code: true, name: true } },
  _count: { select: { employees: true, kpiGroups: true } },
} satisfies Prisma.EmployeeGroupInclude;

@Injectable()
export class EmployeeGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lọc theo `departmentId` trả về nhóm của phòng ban đó **và** nhóm dùng chung (departmentId
   * null) — đúng tập nhóm có thể gán cho nhân sự/nhóm KPI của phòng ban đó.
   */
  list(query: ListEmployeeGroupsQueryDto = {}) {
    return this.prisma.employeeGroup.findMany({
      where: {
        status: query.status,
        ...(query.departmentId
          ? {
              OR: [
                { departmentId: query.departmentId },
                { departmentId: null },
              ],
            }
          : {}),
      },
      orderBy: [{ departmentId: 'asc' }, { name: 'asc' }],
      include: GROUP_INCLUDE,
    });
  }

  async getOrThrow(id: number) {
    const group = await this.prisma.employeeGroup.findUnique({
      where: { id },
      include: GROUP_INCLUDE,
    });
    if (!group) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhóm nghiệp vụ',
        HttpStatus.NOT_FOUND,
      );
    }
    return group;
  }

  async create(dto: CreateEmployeeGroupDto) {
    await this.assertDepartmentExists(dto.departmentId);
    await this.assertRoleExists(dto.defaultRoleId);
    const latest = await this.prisma.employeeGroup.aggregate({
      _max: { id: true },
    });
    const code = `EG-${String((latest._max.id ?? 0) + 1).padStart(4, '0')}`;

    return this.prisma.employeeGroup.create({
      data: {
        code,
        name: dto.name.trim(),
        description: dto.description?.trim(),
        departmentId: dto.departmentId ?? null,
        defaultRoleId: dto.defaultRoleId ?? null,
        jobTitleKeywords: normalizeKeywords(dto.jobTitleKeywords),
        status: dto.status,
      },
      include: GROUP_INCLUDE,
    });
  }

  async update(id: number, dto: UpdateEmployeeGroupDto) {
    const existing = await this.getOrThrow(id);
    await this.assertDepartmentExists(dto.departmentId);
    await this.assertRoleExists(dto.defaultRoleId);
    if (
      dto.departmentId !== undefined &&
      dto.departmentId !== existing.departmentId
    ) {
      await this.assertNoCrossDepartmentUsage(id, dto.departmentId);
    }

    return this.prisma.employeeGroup.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        description: dto.description === null ? null : dto.description?.trim(),
        departmentId: dto.departmentId,
        defaultRoleId: dto.defaultRoleId,
        jobTitleKeywords: dto.jobTitleKeywords
          ? normalizeKeywords(dto.jobTitleKeywords)
          : undefined,
        status: dto.status,
      },
      include: GROUP_INCLUDE,
    });
  }

  /**
   * Xóa cứng chỉ khi nhóm chưa được gán ở đâu — dữ liệu đã gán (kể cả snapshot kỳ đã chốt) phải
   * đọc lại được tên nhóm. Nhóm đang dùng thì chuyển status=INACTIVE thay vì xóa.
   */
  async remove(id: number) {
    const group = await this.getOrThrow(id);
    const usage: string[] = [];
    if (group._count.employees > 0) {
      usage.push(`${group._count.employees} nhân sự`);
    }
    if (group._count.kpiGroups > 0) {
      usage.push(`${group._count.kpiGroups} nhóm KPI`);
    }
    if (usage.length > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `Nhóm nghiệp vụ đang được dùng bởi ${usage.join(' và ')} nên không thể xóa. Hãy chuyển sang trạng thái Ngừng dùng.`,
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.employeeGroup.delete({ where: { id } });
  }

  private async assertDepartmentExists(
    departmentId: number | null | undefined,
  ) {
    if (!departmentId) return;
    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
    });
    if (!department) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'departmentId không tồn tại',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertRoleExists(roleId: number | null | undefined) {
    if (!roleId) return;
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'defaultRoleId không tồn tại',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Chuyển nhóm sang phòng ban khác sẽ làm những nhân sự/nhóm KPI đang gán rơi ra ngoài phạm vi
   * phòng ban mới. Chặn sớm thay vì để dữ liệu mâu thuẫn âm thầm tồn tại.
   */
  private async assertNoCrossDepartmentUsage(
    id: number,
    departmentId: number | null,
  ) {
    if (departmentId === null) return;

    const [employeeCount, kpiGroupCount] = await Promise.all([
      this.prisma.employee.count({
        where: {
          employeeGroups: { some: { id } },
          team: { departmentId: { not: departmentId } },
        },
      }),
      this.prisma.kpiGroup.count({
        where: {
          applicableEmployeeGroups: { some: { id } },
          teams: { some: { department: { id: { not: departmentId } } } },
        },
      }),
    ]);

    const blockers: string[] = [];
    if (employeeCount > 0) blockers.push(`${employeeCount} nhân sự`);
    if (kpiGroupCount > 0) blockers.push(`${kpiGroupCount} nhóm KPI`);
    if (blockers.length > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `Không thể chuyển nhóm sang phòng ban khác: đang có ${blockers.join(' và ')} thuộc phòng ban cũ dùng nhóm này.`,
        HttpStatus.CONFLICT,
      );
    }
  }
}

function normalizeKeywords(keywords: string[] | undefined) {
  if (!keywords) return undefined;
  return Array.from(
    new Set(
      keywords.map((keyword) => normalizeJobTitle(keyword)).filter(Boolean),
    ),
  );
}
