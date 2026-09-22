import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class CreateKpiAssignmentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  kpiGroupId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId?: number;
}

export class ListKpiAssignmentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId?: number;
}
