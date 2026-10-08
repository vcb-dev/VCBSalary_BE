-- Cho phép nhập tay traffic ở nền tảng ngoài TikTok/Facebook/YouTube/Instagram. Mọi nền tảng tự
-- nhập dùng chung giá trị OTHER, phân biệt bằng platform_name; nền tảng cố định để chuỗi rỗng nên
-- unique (nhân sự, kỳ, nền tảng) cũ vẫn giữ nguyên ý nghĩa với chúng.
ALTER TYPE "TrafficPlatform" ADD VALUE 'OTHER';

ALTER TABLE "employee_traffic_records" ADD COLUMN "platform_name" VARCHAR(100) NOT NULL DEFAULT '';

-- Tên unique cũ và mới trùng nhau vì Prisma cắt tên index về 63 ký tự.
DROP INDEX "employee_traffic_records_employee_id_payroll_period_id_plat_key";

CREATE UNIQUE INDEX "employee_traffic_records_employee_id_payroll_period_id_plat_key" ON "employee_traffic_records"("employee_id", "payroll_period_id", "platform", "platform_name");
