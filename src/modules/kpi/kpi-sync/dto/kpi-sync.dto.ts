import { Type } from 'class-transformer';
import { IsInt, IsUUID, Min } from 'class-validator';

export class TriggerKpiSyncDto {
  @IsUUID()
  externalTeamId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  payrollPeriodId: number;
}
