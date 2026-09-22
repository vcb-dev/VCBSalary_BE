import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const MONEY_PATTERN = /^(0|[1-9]\d{0,17})$/;

export class CreateKpiRewardRateDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  kpiGroupId: number;

  @IsString()
  @Matches(MONEY_PATTERN)
  rewardAmount: string;

  @IsDateString()
  effectiveFrom: string;
}

export class UpdateKpiRewardRateDto {
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  rewardAmount?: string;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString()
  effectiveTo?: string | null;
}
