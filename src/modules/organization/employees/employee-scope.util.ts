import type { Prisma } from '@prisma/client';
import type { ResolvedScope } from '../../../common/types/resolved-scope.types';

/** Empty IN() luôn trả về 0 dòng — an toàn hơn so sánh id với chuỗi không phải UUID. */
const NO_MATCH: Prisma.EmployeeWhereInput = { id: { in: [] } };

export function buildEmployeeScopeWhere(
  scope: ResolvedScope,
  selfEmployeeId: number | null,
): Prisma.EmployeeWhereInput {
  switch (scope.type) {
    case 'ALL':
      return {};
    case 'TEAM':
      return scope.teamIds.length > 0
        ? {
            OR: [
              { teamId: { in: scope.teamIds } },
              {
                teamMemberships: {
                  some: { teamId: { in: scope.teamIds }, isActive: true },
                },
              },
            ],
          }
        : NO_MATCH;
    case 'SELF':
      return selfEmployeeId ? { id: selfEmployeeId } : NO_MATCH;
    case 'NONE':
    default:
      return NO_MATCH;
  }
}
