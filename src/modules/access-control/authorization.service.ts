import { Injectable } from '@nestjs/common';
import { Prisma, ScopeType } from '@prisma/client';
import { memoizeForRequest } from '../../common/request-context';
import type { ResolvedScope } from '../../common/types/resolved-scope.types';
import { PrismaService } from '../../prisma/prisma.service';

type ScopeLevel = 'self' | 'team' | 'all';
type RoleGrant = {
  scopeType: ScopeType;
  scopeTeamId: number | null;
  role: {
    rolePermissions: { permission: { code: string } }[];
  };
};

const ACCESS_PROFILE_SELECT = {
  id: true,
  email: true,
  status: true,
  employeeId: true,
  userRoles: {
    select: {
      scopeType: true,
      scopeTeamId: true,
      role: {
        select: {
          rolePermissions: {
            select: { permission: { select: { code: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.UserSelect;

export type AccessProfile = Prisma.UserGetPayload<{
  select: typeof ACCESS_PROFILE_SELECT;
}>;

const SCOPE_RANK: Record<ScopeLevel, number> = {
  self: 1,
  team: 2,
  all: 3,
};

@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tài khoản + mọi lần gán role + employeeId trong một truy vấn, dùng chung cho cả request: JWT
   * strategy, PermissionsGuard và service không phải tải lại role/permission mỗi lần hỏi scope.
   */
  getAccessProfile(userId: string): Promise<AccessProfile | null> {
    return memoizeForRequest(`access-profile:${userId}`, () =>
      this.prisma.user.findUnique({
        where: { id: userId },
        select: ACCESS_PROFILE_SELECT,
      }),
    );
  }

  private async loadUserRoleGrants(userId: string): Promise<RoleGrant[]> {
    const profile = await this.getAccessProfile(userId);
    return profile?.userRoles ?? [];
  }

  async getPermissionCodes(userId: string): Promise<Set<string>> {
    const grants = await this.loadUserRoleGrants(userId);
    return this.collectPermissionCodes(grants);
  }

  async hasPermission(
    userId: string,
    permissionCode: string,
  ): Promise<boolean> {
    const codes = await this.getPermissionCodes(userId);
    return codes.has(permissionCode);
  }

  async hasAnyPermission(
    userId: string,
    permissionCodes: string[],
  ): Promise<boolean> {
    const codes = await this.getPermissionCodes(userId);
    return permissionCodes.some((code) => codes.has(code));
  }

  async resolveScope(
    userId: string,
    resourcePrefix: string,
  ): Promise<ResolvedScope> {
    const grants = await this.loadUserRoleGrants(userId);
    return this.resolveResourceScope(grants, resourcePrefix);
  }

  /**
   * Phạm vi của một hành động cụ thể. Chỉ những lần gán role thực sự chứa permission được yêu
   * cầu mới đóng góp scope; nhờ vậy quyền ở team A không thể "mượn" scope từ role khác ở team B.
   */
  async resolvePermissionScope(
    userId: string,
    permissionCodes: string | readonly string[],
  ): Promise<ResolvedScope> {
    const required = new Set(
      typeof permissionCodes === 'string' ? [permissionCodes] : permissionCodes,
    );
    const grants = await this.loadUserRoleGrants(userId);
    return this.resolveScopeForPermissions(grants, required);
  }

  /** employeeId của user hiện tại, dùng để lọc dữ liệu khi resolveScope trả về SELF. */
  async getEmployeeId(userId: string): Promise<number | null> {
    const profile = await this.getAccessProfile(userId);
    return profile?.employeeId ?? null;
  }

  private collectPermissionCodes(grants: readonly RoleGrant[]): Set<string> {
    const codes = new Set<string>();
    for (const { role } of grants) {
      for (const { permission } of role.rolePermissions) {
        codes.add(permission.code);
      }
    }
    return codes;
  }

  /** Permission is the upper bound; a role assignment may only narrow its data scope. */
  private resolveResourceScope(
    grants: readonly RoleGrant[],
    resourcePrefix: string,
  ): ResolvedScope {
    const effectiveGrants = grants.flatMap((grant) => {
      const permissionLevel = this.strongestViewLevel(grant, resourcePrefix);
      const effectiveGrant = permissionLevel
        ? this.restrictGrantToPermissionLevel(grant, permissionLevel)
        : null;
      return effectiveGrant ? [effectiveGrant] : [];
    });
    return this.mergeGrantScopes(effectiveGrants);
  }

  private resolveScopeForPermissions(
    grants: readonly RoleGrant[],
    permissionCodes: ReadonlySet<string>,
  ): ResolvedScope {
    return this.mergeGrantScopes(
      grants.filter(({ role }) =>
        role.rolePermissions.some(({ permission }) =>
          permissionCodes.has(permission.code),
        ),
      ),
    );
  }

  private strongestViewLevel(
    grant: RoleGrant,
    resourcePrefix: string,
  ): ScopeLevel | null {
    const levels = grant.role.rolePermissions
      .map(({ permission }) => permission.code)
      .map((code): ScopeLevel | null => {
        if (code === `${resourcePrefix}.view_self`) return 'self';
        if (code === `${resourcePrefix}.view_team`) return 'team';
        if (code === `${resourcePrefix}.view_all`) return 'all';
        return null;
      })
      .filter((level): level is ScopeLevel => level !== null);

    return levels.reduce<ScopeLevel | null>(
      (strongest, level) =>
        !strongest || SCOPE_RANK[level] > SCOPE_RANK[strongest]
          ? level
          : strongest,
      null,
    );
  }

  private restrictGrantToPermissionLevel(
    grant: RoleGrant,
    permissionLevel: ScopeLevel,
  ): RoleGrant | null {
    if (grant.scopeType === ScopeType.SELF || permissionLevel === 'self') {
      return { ...grant, scopeType: ScopeType.SELF, scopeTeamId: null };
    }
    if (grant.scopeType === ScopeType.TEAM) return grant;
    return permissionLevel === 'all' ? grant : null;
  }

  private mergeGrantScopes(grants: readonly RoleGrant[]): ResolvedScope {
    let hasSelfScope = false;
    const teamIds = new Set<number>();

    for (const grant of grants) {
      if (grant.scopeType === ScopeType.ALL) return { type: 'ALL' };
      if (grant.scopeType === ScopeType.TEAM && grant.scopeTeamId) {
        teamIds.add(grant.scopeTeamId);
      }
      if (grant.scopeType === ScopeType.SELF) hasSelfScope = true;
    }

    if (teamIds.size > 0) return { type: 'TEAM', teamIds: [...teamIds] };
    return hasSelfScope ? { type: 'SELF' } : { type: 'NONE' };
  }
}
