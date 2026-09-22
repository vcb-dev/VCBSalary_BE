import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/utils/pagination.dto';

export class ListNotificationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value as boolean;
  })
  @IsBoolean()
  unread?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  type?: string;
}
