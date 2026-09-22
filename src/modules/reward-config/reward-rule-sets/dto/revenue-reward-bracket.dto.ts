import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';

const MONEY_PATTERN = /^(0|[1-9]\d{0,17})$/;
const DECIMAL_18_4_PATTERN = /^(0|[1-9]\d{0,13})(\.\d{1,4})?$/;
const PERCENT_PATTERN = /^(0|[1-9]\d{0,2})(\.\d{1,4})?$/;

export class CreateRevenueRewardBracketDto {
  @IsString()
  @MaxLength(120)
  label: string;

  @IsString()
  @Matches(MONEY_PATTERN)
  minRevenueAmount: string;

  /** Bỏ trống = bracket cao nhất (không giới hạn trên). */
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  maxRevenueAmount?: string;

  @IsString()
  @Matches(PERCENT_PATTERN)
  commissionRatePercent: string;

  @IsString()
  @Matches(DECIMAL_18_4_PATTERN)
  rpmRatePer1000Views: string;
}

export class UpdateRevenueRewardBracketDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  minRevenueAmount?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  maxRevenueAmount?: string | null;

  @IsOptional()
  @IsString()
  @Matches(PERCENT_PATTERN)
  commissionRatePercent?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_18_4_PATTERN)
  rpmRatePer1000Views?: string;
}
