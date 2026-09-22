-- Index này trùng hoàn toàn với unique key payroll_periods_payroll_year_payroll_month_key
-- (cùng bảng, cùng thứ tự cột). Postgres dùng unique index cho mọi truy vấn mà index thường
-- phục vụ, nên bản sao chỉ làm chậm INSERT/UPDATE và tốn dung lượng.
DROP INDEX IF EXISTS "payroll_periods_payroll_year_payroll_month_idx";
