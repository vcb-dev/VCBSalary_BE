import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsBoolean,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { KpiDataSource } from '@prisma/client';

export class CreateKpiGroupDto {
  @IsString()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(KpiDataSource)
  dataSource?: KpiDataSource;

  /// Rỗng = chỉ gán thủ công. Có giá trị = tự gán khi mở kỳ cho nhân sự có ít nhất một nhóm khớp.
  /// Chỉ nhận nhóm nghiệp vụ cùng phòng ban với `teamIds` (hoặc nhóm dùng chung mọi phòng ban).
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  applicableEmployeeGroupIds?: number[];

  /// Một nhóm KPI có thể dùng chung nhiều team. Nhóm cũ không có team vẫn được giữ để tương thích,
  /// nhưng mọi nhóm tạo mới phải xác định phạm vi team ngay từ đầu.
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  teamIds: number[];
}

export class UpdateKpiGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(KpiDataSource)
  dataSource?: KpiDataSource;

  /// Rỗng = chỉ gán thủ công. Có giá trị = tự gán khi mở kỳ cho nhân sự có ít nhất một nhóm khớp.
  /// Chỉ nhận nhóm nghiệp vụ cùng phòng ban với `teamIds` (hoặc nhóm dùng chung mọi phòng ban).
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  applicableEmployeeGroupIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  teamIds?: number[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
