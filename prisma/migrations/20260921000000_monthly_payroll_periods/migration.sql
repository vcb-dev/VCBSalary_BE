-- Mỗi tháng dương lịch chỉ có đúng một kỳ lương. Hai cột tường minh giúp lọc thống kê theo
-- năm mà không phải áp hàm EXTRACT lên start_date (vốn làm mất lợi ích của index).
ALTER TABLE "payroll_periods"
ADD COLUMN "payroll_year" INTEGER,
ADD COLUMN "payroll_month" INTEGER;

UPDATE "payroll_periods"
SET
  "payroll_year" = EXTRACT(YEAR FROM "start_date")::INTEGER,
  "payroll_month" = EXTRACT(MONTH FROM "start_date")::INTEGER;

ALTER TABLE "payroll_periods"
ALTER COLUMN "payroll_year" SET NOT NULL,
ALTER COLUMN "payroll_month" SET NOT NULL;

ALTER TABLE "payroll_periods"
ADD CONSTRAINT "payroll_periods_payroll_month_check"
CHECK ("payroll_month" BETWEEN 1 AND 12);

CREATE UNIQUE INDEX "payroll_periods_payroll_year_payroll_month_key"
ON "payroll_periods"("payroll_year", "payroll_month");

CREATE INDEX "payroll_periods_payroll_year_payroll_month_idx"
ON "payroll_periods"("payroll_year", "payroll_month");
