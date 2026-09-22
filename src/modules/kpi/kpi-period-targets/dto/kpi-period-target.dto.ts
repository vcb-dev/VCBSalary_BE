import { IsNumber, Min } from 'class-validator';

export class PutKpiPeriodTargetDto {
  // Business rule: "Target phải > 0 nếu KPI đó được dùng để tính progress" — V1 chưa có target
  // nào không dùng để tính progress nên áp dụng > 0 cho mọi target.
  @IsNumber()
  @Min(0.0001)
  targetValue: number;
}
