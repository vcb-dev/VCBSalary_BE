import { ProposalType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  Min,
  MinLength,
} from 'class-validator';

const MONEY_PATTERN = /^(0|[1-9]\d{0,17})$/;

export class CreateKpiOkrProposalDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  payrollPeriodId: number;

  @IsEnum(ProposalType)
  proposalType: ProposalType;

  // Bắt buộc nếu proposalType = KPI_ITEM (thêm item vào group nào), cấm nếu = OKR — validate
  // trong service vì phụ thuộc lẫn nhau giữa 2 field, class-validator không diễn tả gọn được.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  proposedKpiGroupId?: number;

  @IsString()
  @MaxLength(250)
  proposedName: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  proposedUnit?: string;

  @IsNumber()
  @Min(0.0001)
  proposedTargetValue: number;

  // Bắt buộc nếu proposalType = OKR (employee_okrs.reward_amount NOT NULL khi approve tự tạo).
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN)
  proposedRewardAmount?: string;

  @IsOptional()
  @IsDateString()
  proposedDeadline?: string;

  @IsString()
  @MinLength(1)
  reason: string;
}

export class RejectProposalDto {
  // Bắt buộc theo spec: "reject phải có reason".
  @IsString()
  @MinLength(1)
  reason: string;
}
