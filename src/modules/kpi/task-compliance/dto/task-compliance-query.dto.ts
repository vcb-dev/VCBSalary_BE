import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/utils/pagination.dto';

export class TaskComplianceQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  teamId?: number;
}
