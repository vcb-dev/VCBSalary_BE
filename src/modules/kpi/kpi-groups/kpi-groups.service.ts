import { HttpStatus, Injectable } from '@nestjs/common';
import { KpiDataSource } from '@prisma/client';
import { AuthorizationService } from '../../access-control/authorization.service';
import { AuditLogService } from '../../audit/audit-log.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { assertEmployeeGroupsAssignable } from '../../organization/employee-groups/employee-group.util';
import { PrismaService } from '../../../prisma/prisma.service';
import type { CreateKpiGroupDto, UpdateKpiGroupDto } from './dto/kpi-group.dto';
import type { CreateKpiItemDto, UpdateKpiItemDto } from './dto/kpi-item.dto';

// Nhóm nghiệp vụ được tự gán: FE cần id + tên để hiển thị badge và dựng lại form sửa.
const APPLICABLE_GROUP_SELECT = {
  select: { id: true, code: true, name: true, departmentId: true },
  orderBy: { name: 'asc' },
} as const;

@Injectable()
export class KpiGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly authorization: AuthorizationService,
  ) {}

  list() {
    return this.prisma.kpiGroup.findMany({
      orderBy: { name: 'asc' },
      include: {
        teams: { orderBy: { name: 'asc' } },
        applicableEmployeeGroups: APPLICABLE_GROUP_SELECT,
        _count: { select: { items: true } },
      },
    });
  }

  async getOrThrow(id: number) {
    const group = await this.prisma.kpiGroup.findUnique({
      where: { id },
      include: {
        teams: { orderBy: { name: 'asc' } },
        applicableEmployeeGroups: APPLICABLE_GROUP_SELECT,
        items: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!group) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhóm KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    return group;
  }

  async create(dto: CreateKpiGroupDto, actorUserId: string) {
    this.assertSupportedDataSource(dto.dataSource);
    const teams = await this.assertTeamsExist(dto.teamIds);
    await this.assertCanConfigureTeams(actorUserId, dto.teamIds);
    const applicableEmployeeGroupIds = dto.applicableEmployeeGroupIds ?? [];
    await this.assertEmployeeGroupsMatchTeams(
      applicableEmployeeGroupIds,
      teams,
    );
    const latest = await this.prisma.kpiGroup.aggregate({ _max: { id: true } });
    const code = `KPI-G-${String((latest._max.id ?? 0) + 1).padStart(5, '0')}`;

    return this.prisma.$transaction(async (tx) => {
      const group = await tx.kpiGroup.create({
        data: {
          code,
          name: dto.name,
          description: dto.description,
          dataSource: dto.dataSource,
          applicableEmployeeGroups: {
            connect: applicableEmployeeGroupIds.map((id) => ({ id })),
          },
          teams: { connect: dto.teamIds.map((id) => ({ id })) },
          createdByUserId: actorUserId,
        },
        include: { applicableEmployeeGroups: APPLICABLE_GROUP_SELECT },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_GROUP_CREATED',
        entityType: 'KpiGroup',
        entityId: group.id,
        afterData: {
          code: group.code,
          name: group.name,
          applicableEmployeeGroupIds,
          teamIds: dto.teamIds,
        },
      });
      return group;
    });
  }

  async update(id: number, dto: UpdateKpiGroupDto, actorUserId: string) {
    const existing = await this.getGroupOrThrow(id);
    // Cho phép sửa metadata/team của nhóm nguồn đã seed; chỉ chặn đổi nhóm nội bộ sang nguồn
    // AutomationGenVideo vì code sinh tự động sẽ không khớp contract của hệ thống nguồn.
    if (existing.dataSource !== KpiDataSource.AUTOMATION_GEN_VIDEO) {
      this.assertSupportedDataSource(dto.dataSource);
    }
    const teams = dto.teamIds
      ? await this.assertTeamsExist(dto.teamIds)
      : (existing.teams ?? []);
    if (dto.applicableEmployeeGroupIds) {
      await this.assertEmployeeGroupsMatchTeams(
        dto.applicableEmployeeGroupIds,
        teams,
        existing.applicableEmployeeGroups.map((group) => group.id),
      );
    }
    // Sửa metadata/đầu mục cũng ảnh hưởng mọi team đang dùng nhóm này. Leader chỉ được sửa khi
    // có scope trên TOÀN BỘ team của nhóm (và cả team mới nếu thay đổi danh sách).
    await this.assertCanConfigureTeams(
      actorUserId,
      dto.teamIds ?? (existing.teams ?? []).map((team) => team.id),
    );

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.kpiGroup.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          dataSource: dto.dataSource,
          applicableEmployeeGroups: dto.applicableEmployeeGroupIds
            ? {
                set: dto.applicableEmployeeGroupIds.map((groupId) => ({
                  id: groupId,
                })),
              }
            : undefined,
          teams: dto.teamIds
            ? { set: dto.teamIds.map((teamId) => ({ id: teamId })) }
            : undefined,
          isActive: dto.isActive,
        },
        include: { applicableEmployeeGroups: APPLICABLE_GROUP_SELECT },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_GROUP_UPDATED',
        entityType: 'KpiGroup',
        entityId: id,
        beforeData: {
          code: existing.code,
          name: existing.name,
          isActive: existing.isActive,
          applicableEmployeeGroupIds: existing.applicableEmployeeGroups.map(
            (group) => group.id,
          ),
          teamIds: (existing.teams ?? []).map((team) => team.id),
        },
        afterData: { ...dto },
      });
      return updated;
    });
  }

  /**
   * Xóa cứng nhóm KPI + toàn bộ đầu mục của nó. CHỈ cho phép khi nhóm chưa phát sinh dữ liệu
   * nghiệp vụ (chưa gán cho nhân sự, chưa có target/actual theo kỳ, chưa bị đề xuất tham chiếu) —
   * đúng business rule "không phá lịch sử lương". Nếu đã có, ném CONFLICT để người dùng dùng
   * soft-disable (isActive=false) qua PATCH thay vì xóa.
   */
  async remove(id: number, actorUserId: string) {
    const existing = await this.getGroupOrThrow(id);
    await this.assertCanManageTeamsWithPermission(
      actorUserId,
      (existing.teams ?? []).map((team) => team.id),
      'kpi.delete_group',
    );

    const [
      assignmentCount,
      targetCount,
      actualCount,
      proposalCount,
      rewardRateCount,
    ] = await Promise.all([
      this.prisma.employeeKpiAssignment.count({ where: { kpiGroupId: id } }),
      this.prisma.kpiPeriodTarget.count({
        where: { kpiItem: { kpiGroupId: id } },
      }),
      this.prisma.employeeKpiActual.count({
        where: { kpiItem: { kpiGroupId: id } },
      }),
      this.prisma.kpiOkrProposal.count({
        where: { proposedKpiGroupId: id },
      }),
      this.prisma.employeeKpiRewardRate.count({
        where: { kpiGroupId: id },
      }),
    ]);

    if (
      assignmentCount +
        targetCount +
        actualCount +
        proposalCount +
        rewardRateCount >
      0
    ) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Nhóm KPI đã phát sinh dữ liệu (gán cho nhân sự, target, actual, mức thưởng hoặc đề xuất) nên không thể xóa. Hãy chuyển trạng thái sang "Đã tắt" để ngừng dùng mà vẫn giữ lịch sử.',
        HttpStatus.CONFLICT,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_GROUP_DELETED',
        entityType: 'KpiGroup',
        entityId: id,
        beforeData: {
          code: existing.code,
          name: existing.name,
          isActive: existing.isActive,
          applicableEmployeeGroupIds: existing.applicableEmployeeGroups.map(
            (group) => group.id,
          ),
          teamIds: (existing.teams ?? []).map((team) => team.id),
        },
      });
      await tx.kpiItem.deleteMany({ where: { kpiGroupId: id } });
      await tx.kpiGroup.delete({ where: { id } });
    });
  }

  async createItem(
    groupId: number,
    dto: CreateKpiItemDto,
    actorUserId: string,
  ) {
    const group = await this.getGroupOrThrow(groupId);
    await this.assertCanConfigureTeams(
      actorUserId,
      (group.teams ?? []).map((team) => team.id),
    );
    const latest = await this.prisma.kpiItem.aggregate({ _max: { id: true } });
    const code = `KPI-I-${String((latest._max.id ?? 0) + 1).padStart(6, '0')}`;

    return this.prisma.$transaction(async (tx) => {
      const item = await tx.kpiItem.create({
        data: {
          kpiGroupId: groupId,
          code,
          name: dto.name,
          unit: dto.unit,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_ITEM_CREATED',
        entityType: 'KpiItem',
        entityId: item.id,
        afterData: { kpiGroupId: groupId, code: item.code, name: item.name },
      });
      return item;
    });
  }

  async updateItem(id: number, dto: UpdateKpiItemDto, actorUserId: string) {
    const existing = await this.getItemOrThrow(id);
    await this.assertCanConfigureTeams(
      actorUserId,
      (existing.kpiGroup?.teams ?? []).map((team) => team.id),
    );

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.kpiItem.update({
        where: { id },
        data: {
          name: dto.name,
          unit: dto.unit,
          sortOrder: dto.sortOrder,
          isActive: dto.isActive,
        },
      });
      await this.auditLog.record(tx, {
        actorUserId,
        action: 'KPI_ITEM_UPDATED',
        entityType: 'KpiItem',
        entityId: id,
        beforeData: {
          name: existing.name,
          unit: existing.unit,
          isActive: existing.isActive,
        },
        afterData: { ...dto },
      });
      return updated;
    });
  }

  private async getGroupOrThrow(id: number) {
    const group = await this.prisma.kpiGroup.findUnique({
      where: { id },
      include: {
        teams: true,
        applicableEmployeeGroups: { select: { id: true } },
      },
    });
    if (!group) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhóm KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    return group;
  }

  private async getItemOrThrow(id: number) {
    const item = await this.prisma.kpiItem.findUnique({
      where: { id },
      include: { kpiGroup: { include: { teams: true } } },
    });
    if (!item) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy đầu mục KPI',
        HttpStatus.NOT_FOUND,
      );
    }
    return item;
  }

  private async assertTeamsExist(teamIds: number[]) {
    if (teamIds.length === 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Chọn ít nhất một team áp dụng cho nhóm KPI',
        HttpStatus.BAD_REQUEST,
      );
    }
    const teams = await this.prisma.team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, departmentId: true },
    });
    if (teams.length !== teamIds.length) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Có team áp dụng không tồn tại',
        HttpStatus.NOT_FOUND,
      );
    }
    return teams;
  }

  /**
   * Nhóm nghiệp vụ gắn phòng ban chỉ tự gán được cho nhân sự của chính phòng ban đó. Nếu nhóm KPI
   * áp dụng cho team ở phòng ban khác thì cấu hình "tự gán" sẽ không bao giờ khớp ai — chặn ngay
   * lúc cấu hình thay vì để phát hiện khi mở kỳ.
   */
  private async assertEmployeeGroupsMatchTeams(
    employeeGroupIds: number[],
    teams: Array<{ departmentId: number }>,
    alreadyAssignedIds: number[] = [],
  ) {
    await assertEmployeeGroupsAssignable(
      this.prisma,
      employeeGroupIds,
      Array.from(new Set(teams.map((team) => team.departmentId))),
      alreadyAssignedIds,
    );
  }

  /**
   * `kpi.configure` là gate chức năng; scope kpi TEAM/ALL là gate dữ liệu. Một nhóm không có
   * team là nhóm legacy "toàn hệ thống", do đó chỉ người có scope ALL mới sửa được.
   */
  private async assertCanConfigureTeams(
    actorUserId: string,
    teamIds: number[],
  ) {
    return this.assertCanManageTeamsWithPermission(
      actorUserId,
      teamIds,
      'kpi.configure',
    );
  }

  private async assertCanManageTeamsWithPermission(
    actorUserId: string,
    teamIds: number[],
    permissionCode: 'kpi.configure' | 'kpi.delete_group',
  ) {
    const scope = await this.authorization.resolvePermissionScope(
      actorUserId,
      permissionCode,
    );
    if (scope.type === 'ALL') return;
    if (
      scope.type === 'TEAM' &&
      teamIds.length > 0 &&
      teamIds.every((teamId) => scope.teamIds.includes(teamId))
    ) {
      return;
    }
    throw new AppException(
      ErrorCode.OUT_OF_SCOPE,
      'Bạn chỉ được cấu hình nhóm KPI cho các team trong phạm vi quản lý',
      HttpStatus.FORBIDDEN,
    );
  }

  private assertSupportedDataSource(dataSource?: KpiDataSource) {
    if (dataSource === KpiDataSource.AUTOMATION_GEN_VIDEO) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Nguồn VCBI chưa được hỗ trợ; hãy dùng nguồn nhập tay.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
