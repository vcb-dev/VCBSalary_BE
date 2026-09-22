import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/utils/pagination.dto';

export enum SalaryCalculationMode {
  PREVIEW = 'PREVIEW',
  PERSIST = 'PERSIST',
}

export class CalculateSalaryQueryDto {
  @IsOptional()
  @IsEnum(SalaryCalculationMode)
  mode: SalaryCalculationMode = SalaryCalculationMode.PREVIEW;
}

export class ListSalaryRecordsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 100;
}
