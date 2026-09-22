import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateEmployeeKpiActualDto {
  @IsNumber()
  @Min(0)
  actualValue: number;

  @IsOptional()
  @IsString()
  selfAssessment?: string;
}

export class LeaderRejectKpiDto {
  // Bắt buộc theo spec: "reject phải có reason".
  @IsString()
  @MinLength(1)
  reason: string;
}

export class OverrideKpiActualDto {
  @IsNumber()
  @Min(0)
  overrideValue: number;

  // Bắt buộc theo spec: "Override rules — bắt buộc override value; reason".
  @IsString()
  @MinLength(1)
  reason: string;
}

export class ManualKpiActualDto {
  @IsNumber()
  @Min(0)
  actualValue: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
