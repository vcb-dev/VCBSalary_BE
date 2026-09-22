import { DepartmentStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateDepartmentDto {
  @IsString()
  @MaxLength(150)
  name: string;

  @IsOptional()
  @IsEnum(DepartmentStatus)
  status?: DepartmentStatus;
}

export class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsEnum(DepartmentStatus)
  status?: DepartmentStatus;
}
