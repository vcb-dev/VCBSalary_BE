import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  Min,
  MinLength,
} from 'class-validator';

const MONEY_PATTERN = /^(0|[1-9]\d{0,17})$/;

export class CreateEmployeeOkrDto {
  @IsString()
  @MaxLength(250)
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsNumber()
  @Min(0.0001)
  targetValue: number;

  @IsString()
  @Matches(MONEY_PATTERN)
  rewardAmount: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;
}

// Nhân sự chỉ tự cập nhật actual/tự đánh giá — target/reward/title do Leader/Admin đặt lúc tạo
// (khớp quyền `okr.update_self`, không có field nào khác trong mục API M08 cho việc sửa định nghĩa).
export class UpdateEmployeeOkrDto {
  @IsNumber()
  @Min(0)
  actualValue: number;

  @IsOptional()
  @IsString()
  selfAssessment?: string;
}

export class UpdateEmployeeOkrRewardDto {
  @IsString()
  @Matches(MONEY_PATTERN)
  rewardAmount: string;
}

export class LeaderRejectOkrDto {
  // Bắt buộc theo spec: "reject phải có reason".
  @IsString()
  @MinLength(1)
  reason: string;
}

export class OverrideEmployeeOkrDto {
  @IsNumber()
  @Min(0)
  overrideValue: number;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason: string;
}
