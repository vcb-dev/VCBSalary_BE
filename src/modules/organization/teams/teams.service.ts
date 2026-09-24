import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../prisma/prisma.service';
import type { CreateTeamDto, UpdateTeamDto } from './dto/team.dto';

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.team.findMany({
      orderBy: { name: 'asc' },
      include: { department: true },
    });
  }

  async getOrThrow(id: number) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { department: true },
    });
    if (!team) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy team',
        HttpStatus.NOT_FOUND,
      );
    }
    return team;
  }

  async create(dto: CreateTeamDto) {
    await this.assertDepartmentExists(dto.departmentId);
    const latest = await this.prisma.team.aggregate({ _max: { id: true } });
    const code = `TEAM-${String((latest._max.id ?? 0) + 1).padStart(4, '0')}`;

    return this.prisma.team.create({
      data: {
        code,
        name: dto.name,
        departmentId: dto.departmentId,
        status: dto.status,
      },
      include: { department: true },
    });
  }

  async update(id: number, dto: UpdateTeamDto) {
    const existing = await this.getOrThrow(id);
    if (dto.departmentId) {
      await this.assertDepartmentExists(dto.departmentId);
      if (
        existing.sourceSystem === 'AUTOMATION_GEN_VIDEO' &&
        dto.departmentId !== existing.departmentId
      ) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Team đồng bộ từ VCBI luôn thuộc phòng Marketing',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return this.prisma.team.update({
      where: { id },
      data: {
        name: dto.name,
        departmentId: dto.departmentId,
        status: dto.status,
      },
      include: { department: true },
    });
  }

  /**
   * Xóa cứng team. Chặn mọi trường hợp còn tham chiếu thay vì để database tự xử lý, vì hai trong
   * ba quan hệ sẽ hỏng âm thầm chứ không báo lỗi:
   *  - `user_roles.scope_team_id` là optional → xóa team sẽ set NULL, biến vai trò scope TEAM
   *    thành dòng không có phạm vi (người dùng mất/được sai quyền mà không ai biết).
   *  - Quan hệ N-N với nhóm KPI sẽ tự xóa dòng nối; nhóm KPI chỉ áp dụng cho đúng team này sẽ
   *    còn 0 team, và hệ thống hiểu "0 team" là dữ liệu cũ áp dụng TOÀN BỘ team.
   * Nhân sự thì database đã chặn sẵn (team_id NOT NULL), ở đây chỉ để báo lỗi dễ hiểu.
   */
  async remove(id: number) {
    const team = await this.getOrThrow(id);

    // Team do sync tạo sẽ được tạo lại ở lần đồng bộ sau nên xóa không có tác dụng thật.
    if (team.sourceSystem === 'AUTOMATION_GEN_VIDEO') {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Team đồng bộ từ VCBI sẽ được tạo lại ở lần đồng bộ sau nên không xóa được. Hãy chuyển trạng thái sang "Ngừng hoạt động".',
        HttpStatus.BAD_REQUEST,
      );
    }

    const membershipCount = this.prisma.employeeTeamMembership?.count
      ? this.prisma.employeeTeamMembership.count({ where: { teamId: id } })
      : this.prisma.employee.count({ where: { teamId: id } });
    const [employeeCount, scopedRoleCount, kpiGroupCount] = await Promise.all([
      membershipCount,
      this.prisma.userRole.count({ where: { scopeTeamId: id } }),
      this.prisma.kpiGroup.count({ where: { teams: { some: { id } } } }),
    ]);

    const blockers: string[] = [];
    if (employeeCount > 0) {
      blockers.push(`${employeeCount} nhân sự (kể cả người đã nghỉ)`);
    }
    if (scopedRoleCount > 0) {
      blockers.push(
        `${scopedRoleCount} phân quyền đang lấy team này làm phạm vi`,
      );
    }
    if (kpiGroupCount > 0) {
      blockers.push(`${kpiGroupCount} nhóm KPI đang áp dụng cho team này`);
    }
    if (blockers.length > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `Team còn ${blockers.join(', ')} nên không thể xóa. Hãy chuyển các mục này sang team khác, hoặc chuyển trạng thái team sang "Ngừng hoạt động" để giữ nguyên lịch sử.`,
        HttpStatus.CONFLICT,
        { employeeCount, scopedRoleCount, kpiGroupCount },
      );
    }

    await this.prisma.team.delete({ where: { id } });
  }

  private async assertDepartmentExists(departmentId: number) {
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
}
