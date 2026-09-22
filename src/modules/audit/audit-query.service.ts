import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginate, toSkipTake } from '../../common/utils/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from '../access-control/authorization.service';
import type { ResolvedScope } from '../access-control/authorization.service';
import type {
  ExportAuditLogsQueryDto,
  ListAuditLogsQueryDto,
} from './dto/audit.dto';
import { AUDITED_ACTIONS } from './audit-policy';

const auditInclude = {
  actor: {
    select: {
      id: true,
      fullName: true,
      email: true,
      employee: {
        select: {
          employeeCode: true,
          jobTitle: true,
          team: {
            select: {
              name: true,
              department: { select: { name: true } },
            },
          },
        },
      },
      userRoles: {
        select: { role: { select: { name: true } } },
      },
    },
  },
  targetEmployee: {
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      jobTitle: true,
      employmentStatus: true,
      joinedAt: true,
      leftAt: true,
      team: {
        select: {
          id: true,
          code: true,
          name: true,
          department: { select: { name: true } },
        },
      },
      leader: { select: { id: true, fullName: true } },
      manager: { select: { id: true, fullName: true } },
      employeeGroups: { select: { id: true, name: true } },
    },
  },
  payrollPeriod: {
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      startDate: true,
      endDate: true,
      approvalDeadline: true,
    },
  },
} satisfies Prisma.AuditLogInclude;

type AuditFilters = Omit<ListAuditLogsQueryDto, 'page' | 'pageSize'>;

@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(userId: string, query: ListAuditLogsQueryDto) {
    const where = await this.buildWhere(userId, query);
    const { skip, take } = toSkipTake(query.page, query.pageSize);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        include: auditInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(rows, total, query.page, query.pageSize);
  }

  async getOne(userId: string, id: number) {
    const scopeWhere = await this.buildScopeWhere(userId);
    const row = await this.prisma.auditLog.findFirst({
      where: {
        id,
        action: { in: [...AUDITED_ACTIONS] },
        AND: [scopeWhere],
      },
      include: auditInclude,
    });
    if (!row) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy nhật ký hoạt động trong phạm vi được phép',
        HttpStatus.NOT_FOUND,
      );
    }
    const references = await this.loadReferences(row.beforeData, row.afterData);
    return { ...row, references };
  }

  async exportCsv(userId: string, query: ExportAuditLogsQueryDto) {
    if (!(await this.authorization.hasPermission(userId, 'report.export'))) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Không có quyền xuất dữ liệu',
        HttpStatus.FORBIDDEN,
      );
    }
    const where = await this.buildWhere(userId, query);
    const rows = await this.prisma.auditLog.findMany({
      where,
      include: auditInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10_000,
    });
    const header = [
      'Thời gian',
      'Người thực hiện',
      'Email',
      'Hành động',
      'Loại đối tượng',
      'Mã đối tượng',
      'Nhân sự liên quan',
      'Kỳ lương',
      'Giá trị trước',
      'Giá trị sau',
      'Lý do',
    ];
    const lines = rows.map((row) =>
      [
        row.createdAt.toISOString(),
        row.actor.fullName,
        row.actor.email,
        row.action,
        row.entityType,
        row.entityId,
        row.targetEmployee
          ? `${row.targetEmployee.employeeCode} - ${row.targetEmployee.fullName}`
          : '',
        row.payrollPeriod?.name ?? '',
        row.beforeData == null ? '' : JSON.stringify(row.beforeData),
        row.afterData == null ? '' : JSON.stringify(row.afterData),
        row.reason ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
    return `\uFEFF${header.map(csvCell).join(',')}\r\n${lines.join('\r\n')}`;
  }

  private async buildWhere(
    userId: string,
    query: AuditFilters,
  ): Promise<Prisma.AuditLogWhereInput> {
    const scopeWhere = await this.buildScopeWhere(userId);
    const search = query.search?.trim();
    return {
      AND: [
        scopeWhere,
        { action: { in: [...AUDITED_ACTIONS] } },
        {
          action: query.action || undefined,
          payrollPeriodId: query.payrollPeriodId,
          createdAt: buildDateRange(query.dateFrom, query.dateTo),
          OR: search
            ? [
                { action: { contains: search, mode: 'insensitive' } },
                { entityType: { contains: search, mode: 'insensitive' } },
                { entityId: { contains: search, mode: 'insensitive' } },
                { reason: { contains: search, mode: 'insensitive' } },
                {
                  actor: {
                    is: { fullName: { contains: search, mode: 'insensitive' } },
                  },
                },
                {
                  actor: {
                    is: { email: { contains: search, mode: 'insensitive' } },
                  },
                },
                {
                  targetEmployee: {
                    is: { fullName: { contains: search, mode: 'insensitive' } },
                  },
                },
                {
                  targetEmployee: {
                    is: {
                      employeeCode: { contains: search, mode: 'insensitive' },
                    },
                  },
                },
              ]
            : undefined,
        },
      ],
    };
  }

  private async buildScopeWhere(
    userId: string,
  ): Promise<Prisma.AuditLogWhereInput> {
    const scope = await this.authorization.resolveScope(userId, 'audit');
    if (scope.type === 'ALL') return {};
    if (scope.type === 'TEAM') return teamScopeWhere(userId, scope);
    if (scope.type === 'SELF') {
      const employeeId = await this.authorization.getEmployeeId(userId);
      return {
        OR: [
          { actorUserId: userId },
          ...(employeeId ? [{ targetEmployeeId: employeeId }] : []),
        ],
      };
    }
    return { id: { in: [] } };
  }

  private async loadReferences(
    beforeData: Prisma.JsonValue | null,
    afterData: Prisma.JsonValue | null,
  ) {
    const snapshots = [beforeData, afterData].filter(isJsonObject);
    const teamIds = uniqueNumbers(
      snapshots.flatMap((item) => jsonNumbers(item, 'teamId')),
    );
    const employeeIds = uniqueNumbers(
      snapshots.flatMap((item) => [
        ...jsonNumbers(item, 'leaderEmployeeId'),
        ...jsonNumbers(item, 'managerEmployeeId'),
      ]),
    );
    const employeeGroupIds = uniqueNumbers(
      snapshots.flatMap((item) => jsonNumbers(item, 'employeeGroupIds')),
    );
    const [teams, employees, employeeGroups] = await Promise.all([
      teamIds.length
        ? this.prisma.team.findMany({
            where: { id: { in: teamIds } },
            select: { id: true, name: true },
          })
        : [],
      employeeIds.length
        ? this.prisma.employee.findMany({
            where: { id: { in: employeeIds } },
            select: { id: true, fullName: true },
          })
        : [],
      employeeGroupIds.length
        ? this.prisma.employeeGroup.findMany({
            where: { id: { in: employeeGroupIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    return { teams, employees, employeeGroups };
  }
}

function isJsonObject(
  value: Prisma.JsonValue | null,
): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonNumbers(value: Prisma.JsonObject, key: string) {
  const field = value[key];
  if (typeof field === 'number') return [field];
  if (typeof field === 'string' && /^\d+$/.test(field)) return [Number(field)];
  if (Array.isArray(field)) {
    return field.flatMap((item) =>
      typeof item === 'number' ||
      (typeof item === 'string' && /^\d+$/.test(item))
        ? [Number(item)]
        : [],
    );
  }
  return [];
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values)];
}

function teamScopeWhere(
  userId: string,
  scope: Extract<ResolvedScope, { type: 'TEAM' }>,
): Prisma.AuditLogWhereInput {
  if (scope.teamIds.length === 0) return { actorUserId: userId };
  return {
    OR: [
      { actorUserId: userId },
      { targetTeamIdSnapshot: { in: scope.teamIds } },
      { actorTeamIdSnapshot: { in: scope.teamIds } },
    ],
  };
}

function buildDateRange(dateFrom?: string, dateTo?: string) {
  if (!dateFrom && !dateTo) return undefined;
  const range: Prisma.DateTimeFilter = {};
  if (dateFrom) range.gte = new Date(dateFrom);
  if (dateTo) {
    const end = new Date(dateTo);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo))
      end.setUTCDate(end.getUTCDate() + 1);
    range.lt = end;
  }
  return range;
}

/** Chặn spreadsheet formula injection và escape CSV theo RFC 4180. */
function csvCell(value: unknown) {
  let text = scalarText(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function scalarText(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value.toString();
  }
  return JSON.stringify(value) ?? '';
}
