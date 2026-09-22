import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsInt, IsOptional, Min } from 'class-validator';

/** Giới hạn để một lần gọi không kéo cả nghìn nhân sự — FE phân trang rồi mới hỏi theo trang. */
const MAX_EMPLOYEE_IDS = 200;

/**
 * Query dùng chung cho các endpoint tổng hợp cấu hình theo nhiều nhân sự.
 * `employeeIds` nhận dạng CSV (`?employeeIds=1,2,3`) hoặc lặp key (`?employeeIds=1&employeeIds=2`).
 * Bỏ trống = lấy toàn bộ nhân sự trong phạm vi truy vấn.
 */
export class EmployeeIdsQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    const raw: unknown[] = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [];
    return raw
      .map((item) =>
        typeof item === 'number' ? item : Number(String(item).trim()),
      )
      .filter((item) => Number.isInteger(item) && item > 0);
  })
  @ArrayMaxSize(MAX_EMPLOYEE_IDS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  employeeIds?: number[];
}
