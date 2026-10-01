import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/utils/pagination.dto';

// Thưởng thêm luôn dương và chặn ở dưới 1.000 tỷ để tổng lương không tràn cột Decimal(18, 0).
const BONUS_AMOUNT_PATTERN = /^[1-9]\d{0,11}$/;

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

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

export class CreateSalaryBonusDto {
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name: string;

  @IsString()
  @Matches(BONUS_AMOUNT_PATTERN, {
    message: 'Số tiền thưởng phải là số nguyên dương, tối đa 12 chữ số',
  })
  amount: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(500)
  note?: string;
}
