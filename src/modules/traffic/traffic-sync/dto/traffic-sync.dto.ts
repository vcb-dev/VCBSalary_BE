import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class TriggerTrafficSyncDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  payrollPeriodId: number;

  /**
   * Tên team bên AutomationGenVideo (`Team.name`, ví dụ `Team K2` — KHÔNG phải nhãn hiển thị
   * `Team K2 (Vân Nguyễn)`). Bỏ trống = kéo toàn hệ thống.
   */
  @IsOptional()
  @IsString()
  @MaxLength(150)
  externalTeamName?: string;

  /** Mặc định lấy trọn khoảng ngày của kỳ lương; chỉ truyền khi cần kéo lại một đoạn hẹp hơn. */
  @IsOptional()
  @Matches(YMD, { message: 'dateFrom phải có dạng YYYY-MM-DD' })
  dateFrom?: string;

  @IsOptional()
  @Matches(YMD, { message: 'dateTo phải có dạng YYYY-MM-DD' })
  dateTo?: string;
}
