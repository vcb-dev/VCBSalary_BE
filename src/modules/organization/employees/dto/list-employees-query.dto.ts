import { EmploymentStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../../common/utils/pagination.dto';

export class ListEmployeesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId?: number;

  @IsOptional()
  @IsString()
  jobTitle?: string;

  @IsOptional()
  @IsEnum(EmploymentStatus)
  employmentStatus?: EmploymentStatus;

  /**
   * Bỏ nhân sự đã nghỉ (LEFT) khỏi kết quả — dùng cho các dropdown chọn nhân sự ở FE, nơi chỉ
   * người còn làm việc mới được gán KPI/lương/tài khoản. Bị `employmentStatus` ghi đè nếu truyền
   * cả hai. Cùng quy ước với snapshot kỳ lương (`employmentStatus: { not: LEFT }`).
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value as boolean;
  })
  @IsBoolean()
  excludeLeft?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  leaderEmployeeId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  managerEmployeeId?: number;
}
