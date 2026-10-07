import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { TeamPerformanceController } from './team-performance.controller';
import { TeamPerformanceService } from './team-performance.service';

@Module({
  imports: [AccessControlModule],
  controllers: [TeamPerformanceController],
  providers: [TeamPerformanceService],
})
export class TeamPerformanceModule {}
