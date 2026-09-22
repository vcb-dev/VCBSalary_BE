import { EmployeeGroupStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateEmployeeGroupDto {
  @IsString()
  @MaxLength(150)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // null = nhóm dùng chung mọi phòng ban.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultRoleId?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  jobTitleKeywords?: string[];

  @IsOptional()
  @IsEnum(EmployeeGroupStatus)
  status?: EmployeeGroupStatus;
}

export class UpdateEmployeeGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultRoleId?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  jobTitleKeywords?: string[];

  @IsOptional()
  @IsEnum(EmployeeGroupStatus)
  status?: EmployeeGroupStatus;
}

export class ListEmployeeGroupsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @IsOptional()
  @IsEnum(EmployeeGroupStatus)
  status?: EmployeeGroupStatus;
}
