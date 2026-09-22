import { TeamStatus } from '@prisma/client';
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
  @IsInt()
  @Min(1)
  departmentId?: number;

  @IsOptional()
  @IsEnum(TeamStatus)
  status?: TeamStatus;
}
