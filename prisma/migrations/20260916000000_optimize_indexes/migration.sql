-- PostgreSQL mặc định xem nhiều NULL là khác nhau trong UNIQUE index. Với user_roles,
-- scope_team_id=NULL vẫn phải ngăn trùng cùng user/role/scope.
DROP INDEX "user_roles_user_id_role_id_scope_type_scope_team_id_key";
CREATE UNIQUE INDEX "user_roles_user_id_role_id_scope_type_scope_team_id_key"
ON "user_roles"("user_id", "role_id", "scope_type", "scope_team_id")
NULLS NOT DISTINCT;

-- Ghép khóa run với thứ tự hiển thị để vừa hỗ trợ FK/cascade vừa tránh sort chi tiết sync.
DROP INDEX "org_sync_run_items_org_sync_run_id_idx";
CREATE INDEX "org_sync_run_items_org_sync_run_id_created_at_idx"
ON "org_sync_run_items"("org_sync_run_id", "created_at");

-- Các màn hình snapshot, revenue và traffic đều lọc theo kỳ rồi sắp xếp theo tên nhân sự.
CREATE INDEX "payroll_period_snapshots_period_employee_name_idx"
ON "payroll_period_employee_snapshots"("payroll_period_id", "employee_name_snapshot");

-- Tối đa một bộ quy tắc ACTIVE; index nhỏ và loại bỏ race giữa hai transaction activate.
CREATE UNIQUE INDEX "reward_rule_sets_one_active_idx"
ON "reward_rule_sets"("status")
WHERE "status" = 'ACTIVE';

-- Chặn hai yêu cầu đồng bộ đồng thời cùng team/tháng ở tầng DB.
CREATE UNIQUE INDEX "kpi_sync_runs_one_running_per_team_month_idx"
ON "kpi_sync_runs"("external_team_id", "month")
WHERE "status" = 'RUNNING';

-- Hai index cũ không khớp truy vấn thực tế: mọi aggregate/list item đều bắt đầu bằng run id;
-- employee_id + kpi_item_id không được dùng, trong khi thao tác xóa KPI item cần kpi_item_id.
DROP INDEX "kpi_sync_run_items_kpi_sync_run_id_idx";
DROP INDEX "kpi_sync_run_items_employee_id_kpi_item_id_idx";
DROP INDEX "kpi_sync_run_items_result_status_manual_entry_required_idx";
CREATE INDEX "kpi_sync_run_items_kpi_sync_run_id_result_status_id_idx"
ON "kpi_sync_run_items"("kpi_sync_run_id", "result_status", "id");
CREATE INDEX "kpi_sync_run_items_kpi_item_id_idx"
ON "kpi_sync_run_items"("kpi_item_id");

-- Danh sách OKR luôn lọc employee/kỳ và sắp xếp created_at tăng dần.
DROP INDEX "employee_okrs_employee_id_payroll_period_id_idx";
CREATE INDEX "employee_okrs_employee_id_payroll_period_id_created_at_idx"
ON "employee_okrs"("employee_id", "payroll_period_id", "created_at");
