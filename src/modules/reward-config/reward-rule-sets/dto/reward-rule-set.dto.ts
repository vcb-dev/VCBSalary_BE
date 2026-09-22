import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class CreateRewardRuleSetDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  achievementThresholdPercent: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  effectiveFromPeriodId?: number;

  /**
   * Khi có: clone toàn bộ revenue brackets từ rule set nguồn sang bản DRAFT mới này (đúng luồng
   * "clone/create new DRAFT" trong business rule) — Admin sau đó chỉnh sửa trên bản clone thay vì
   * phải tạo lại từng bracket bằng tay.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cloneRevenueBracketsFromRuleSetId?: number;
}
