-- `salary_type` là ô text tự do chưa từng được dùng: không có validate danh sách giá trị, không
-- được snapshot khi chốt kỳ, và salary-calculator không đọc tới. Lương được quyết định bởi
-- BaseSalaryHistory + reward rule set (KPI/OKR/hoa hồng/RPM), không liên quan cột này.
-- Toàn bộ 59 dòng đang NULL tại thời điểm viết migration nên không mất dữ liệu.
ALTER TABLE "employees" DROP COLUMN "salary_type";
