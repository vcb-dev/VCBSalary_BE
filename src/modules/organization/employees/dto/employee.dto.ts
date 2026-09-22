import { EmploymentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
  MaxLength,
} from 'class-validator';

export class CreateEmployeeDto {
  @IsString()
  @MaxLength(200)
  fullName: string;

  @IsString()
  @MaxLength(100)
  jobTitle: string;

  // Bỏ trống khi tạo = hệ thống tự đoán nhóm theo chức danh (từ khóa khai trong danh mục nhóm).
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  employeeGroupIds?: number[];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId: number;

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

  @IsOptional()
  @IsEnum(EmploymentStatus)
  employmentStatus?: EmploymentStatus;

  @IsOptional()
  @IsDateString()
  joinedAt?: string;
}

export class UpsertEmployeeTeamMembershipDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  salaryWeightPercent: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  leaderEmployeeId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  managerEmployeeId?: number | null;

  @IsOptional()
  @IsDateString()
  joinedAt?: string | null;
}

export class UpdateEmployeeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  // Bỏ trống + có đổi chức danh = đoán lại nhóm theo chức danh mới; gửi [] để xóa hết nhóm.
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  employeeGroupIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  leaderEmployeeId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  managerEmployeeId?: number | null;

  @IsOptional()
  @IsEnum(EmploymentStatus)
  employmentStatus?: EmploymentStatus;

  @IsOptional()
  @IsDateString()
  joinedAt?: string | null;

  @IsOptional()
  @IsDateString()
  leftAt?: string | null;
}
