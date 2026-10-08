import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
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

/** Traffic của nền tảng ngoài danh sách cố định: tên nền tảng do người nhập tự đặt. */
export class CustomTrafficDto extends PutEmployeeTrafficDto {
  // Gộp khoảng trắng để "Shopee  Video" và "Shopee Video" không thành hai nền tảng.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsString()
  @MinLength(1, { message: 'Nhập tên nền tảng' })
  @MaxLength(100)
  platformName: string;
}

export class LeaderRejectTrafficDto {
  @IsString()
  @MinLength(1)
  reason: string;
}
