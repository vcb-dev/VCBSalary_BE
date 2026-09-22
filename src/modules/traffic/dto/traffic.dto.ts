import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/utils/pagination.dto';

export class ListTrafficQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId?: number;
}

export class PutEmployeeTrafficDto {
  /** Chuỗi số nguyên để giữ chính xác BIGINT khi đi qua JSON/JavaScript. */
  @IsString()
  @Matches(/^(0|[1-9]\d{0,17})$/, {
    message: 'views phải là số nguyên không âm, tối đa 18 chữ số',
  })
  views: string;

  /** Khi được gửi, danh sách này thay thế toàn bộ minh chứng hiện có của record. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  attachmentIds?: string[];
}

export class LeaderRejectTrafficDto {
  @IsString()
  @MinLength(1)
  reason: string;
}
