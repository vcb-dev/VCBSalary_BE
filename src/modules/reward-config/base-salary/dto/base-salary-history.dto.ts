import { IsDateString, IsOptional, IsString, Matches } from 'class-validator';

const MONEY_PATTERN = /^(0|[1-9]\d{0,17})$/;

export class CreateBaseSalaryHistoryDto {
  @IsString()
  @Matches(MONEY_PATTERN)
  monthlyBaseSalary: string;

  @IsDateString()
  effectiveFrom: string;
}

export class UpdateBaseSalaryHistoryDto {
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  monthlyBaseSalary?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;
}
