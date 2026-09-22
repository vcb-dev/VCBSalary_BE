import { Transform } from 'class-transformer';
import { IsNumber, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class PutEmployeeKpiTargetDto {
  @IsNumber()
  @Min(0)
  targetValue: number;
}

export class OverrideEmployeeKpiTargetDto {
  @IsNumber()
  @Min(0)
  overrideValue: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason: string;
}
