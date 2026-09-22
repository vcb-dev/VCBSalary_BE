BEGIN;

-- Gỡ ràng buộc duy nhất một-team còn sót lại sau migration 20260918020000_multi_team_kpi.
-- (employee_id, kpi_group_id, payroll_period_id) chặn việc một nhân sự được giao cùng
-- một nhóm KPI ở hai team khác nhau trong cùng kỳ lương — đúng kịch bản đa team.
-- Ràng buộc thay thế là (employee_id, team_id, kpi_group_id, payroll_period_id).
DROP INDEX IF EXISTS "employee_kpi_assignments_employee_id_kpi_group_id_payroll_p_key";

-- Các index tra cứu cũ đã bị index có team_id bao phủ (left-most prefix),
-- giữ lại chỉ làm chậm INSERT/UPDATE.
DROP INDEX IF EXISTS "employee_kpi_assignments_payroll_period_id_employee_id_idx";
DROP INDEX IF EXISTS "employee_kpi_actuals_employee_id_payroll_period_id_idx";
DROP INDEX IF EXISTS "employee_kpi_targets_employee_id_payroll_period_id_idx";

-- Đồng bộ tên index theo quy ước Prisma.
ALTER INDEX "employee_kpi_reward_rates_employee_id_kpi_group_id_effective_fr"
  RENAME TO "employee_kpi_reward_rates_employee_id_kpi_group_id_effectiv_key";

-- updated_at do Prisma @updatedAt ghi, không dùng DEFAULT ở DB.
-- 14/18 bảng đã theo quy ước này; 4 bảng dưới đây bị lệch.
ALTER TABLE "departments" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "employee_groups" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "employee_team_memberships" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "external_employee_identities" ALTER COLUMN "updated_at" DROP DEFAULT;

COMMIT;
