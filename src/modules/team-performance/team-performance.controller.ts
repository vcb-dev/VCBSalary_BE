import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthUserPayload } from '../../common/types/auth-user.types';
import { TeamPerformanceService } from './team-performance.service';

const TEAM_PERFORMANCE_PERMISSIONS = [
  'employee.view_team',
  'employee.view_all',
] as const;

@Controller('payroll-periods')
export class TeamPerformanceController {
  constructor(
    private readonly teamPerformanceService: TeamPerformanceService,
  ) {}

  @RequirePermission(...TEAM_PERFORMANCE_PERMISSIONS)
  @Get(':periodId/teams/:teamId/performance')
  getForTeam(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
    @Param('teamId', ParseIntPipe) teamId: number,
  ) {
    return this.teamPerformanceService.getPerformance(
      user.id,
      periodId,
      teamId,
    );
  }

  @RequirePermission(...TEAM_PERFORMANCE_PERMISSIONS)
  @Get(':periodId/leaders/me/team-performance')
  getForCurrentScope(
    @CurrentUser() user: AuthUserPayload,
    @Param('periodId', ParseIntPipe) periodId: number,
  ) {
    return this.teamPerformanceService.getPerformance(user.id, periodId);
  }
}
