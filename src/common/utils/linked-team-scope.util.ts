import type { Prisma } from '@prisma/client';
import type { ResolvedScope } from '../types/resolved-scope.types';

/**
 * Team đã liên kết AutomationGenVideo nằm trong scope. Trả `null` khi scope không chạm tới team
 * nào (SELF/NONE): dữ liệu đồng bộ là dữ liệu cấp team, không có phạm vi "chính mình".
 */
export function buildLinkedTeamScopeWhere(
  scope: ResolvedScope,
): Prisma.TeamWhereInput | null {
  if (scope.type === 'ALL') return { externalId: { not: null } };
  if (scope.type === 'TEAM') {
    return { id: { in: scope.teamIds }, externalId: { not: null } };
  }
  return null;
}
