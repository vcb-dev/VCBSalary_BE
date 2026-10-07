import { TeamStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTeamDto {
  @IsString()
  @MaxLength(150)
  name: string;

  // FE giữ mọi id ở dạng chuỗi (normalizeIds) nên phải ép về number trước khi validate.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId: number;

  @IsOptional()
  @IsEnum(TeamStatus)
  status?: TeamStatus;
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  departmentId?: number;

  @IsOptional()
  @IsEnum(TeamStatus)
  status?: TeamStatus;
}
