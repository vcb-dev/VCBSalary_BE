import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../common/utils/pagination.dto';

export class ListRevenueQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId?: number;
}

export class PutEmployeeRevenueDto {
  /** Chuỗi số nguyên để không làm mất chính xác NUMERIC(18,0) khi đi qua JavaScript. */
  @IsString()
  @Matches(/^(0|[1-9]\d{0,17})$/, {
    message:
      'officialRevenueAmount phải là số nguyên không âm, tối đa 18 chữ số',
  })
  officialRevenueAmount: string;
}
