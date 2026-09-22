import { ScopeType, UserStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class UserRoleAssignmentDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  roleId: number;

  @IsEnum(ScopeType)
  scopeType: ScopeType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  scopeTeamId?: number;
}

export class SetUserRolesDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => UserRoleAssignmentDto)
  roles: UserRoleAssignmentDto[];
}

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;

  /** Undefined derives defaults from employee groups; [] explicitly creates a user without roles. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => UserRoleAssignmentDto)
  roles?: UserRoleAssignmentDto[];
}

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  /** Undefined keeps the current employee link; null removes it; an id replaces it. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number | null;
}
