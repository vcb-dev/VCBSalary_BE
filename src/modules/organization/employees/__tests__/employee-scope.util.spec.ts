import { buildEmployeeScopeWhere } from '../employee-scope.util';

describe('buildEmployeeScopeWhere', () => {
  it('returns no filter for ALL scope', () => {
    expect(buildEmployeeScopeWhere({ type: 'ALL' }, null)).toEqual({});
  });

  it('filters by teamIds for TEAM scope', () => {
    expect(
      buildEmployeeScopeWhere({ type: 'TEAM', teamIds: ['t1', 't2'] }, null),
    ).toEqual({
      OR: [
        { teamId: { in: ['t1', 't2'] } },
        {
          teamMemberships: {
            some: { teamId: { in: ['t1', 't2'] }, isActive: true },
          },
        },
      ],
    });
  });

  it('matches nothing when TEAM scope has no team ids', () => {
    expect(
      buildEmployeeScopeWhere({ type: 'TEAM', teamIds: [] }, null),
    ).toEqual({
      id: { in: [] },
    });
  });

  it('filters to the linked employee for SELF scope', () => {
    expect(buildEmployeeScopeWhere({ type: 'SELF' }, 'emp-1')).toEqual({
      id: 'emp-1',
    });
  });

  it('matches nothing for SELF scope when the user has no linked employee', () => {
    expect(buildEmployeeScopeWhere({ type: 'SELF' }, null)).toEqual({
      id: { in: [] },
    });
  });

  it('matches nothing for NONE scope', () => {
    expect(buildEmployeeScopeWhere({ type: 'NONE' }, null)).toEqual({
      id: { in: [] },
    });
  });
});
