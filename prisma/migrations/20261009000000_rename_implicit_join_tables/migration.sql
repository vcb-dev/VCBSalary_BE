-- Ba bảng nối nhiều-nhiều ngầm của Prisma (tên `_X`, cột A/B) thành bảng nối tường minh có tên
-- bảng/cột tự giải thích. Chỉ đổi tên nên giữ nguyên dữ liệu, khóa chính và khóa ngoại.

-- _EmployeeEmployeeGroups: A = employees.id, B = employee_groups.id
ALTER TABLE "_EmployeeEmployeeGroups" RENAME TO "employee_group_members";
ALTER TABLE "employee_group_members" RENAME COLUMN "A" TO "employee_id";
ALTER TABLE "employee_group_members" RENAME COLUMN "B" TO "employee_group_id";
ALTER TABLE "employee_group_members" RENAME CONSTRAINT "_EmployeeEmployeeGroups_AB_pkey" TO "employee_group_members_pkey";
ALTER TABLE "employee_group_members" RENAME CONSTRAINT "_EmployeeEmployeeGroups_A_fkey" TO "employee_group_members_employee_id_fkey";
ALTER TABLE "employee_group_members" RENAME CONSTRAINT "_EmployeeEmployeeGroups_B_fkey" TO "employee_group_members_employee_group_id_fkey";
ALTER INDEX "_EmployeeEmployeeGroups_B_index" RENAME TO "employee_group_members_employee_group_id_idx";

-- _KpiGroupTeams: A = kpi_groups.id, B = teams.id
ALTER TABLE "_KpiGroupTeams" RENAME TO "kpi_group_teams";
ALTER TABLE "kpi_group_teams" RENAME COLUMN "A" TO "kpi_group_id";
ALTER TABLE "kpi_group_teams" RENAME COLUMN "B" TO "team_id";
ALTER TABLE "kpi_group_teams" RENAME CONSTRAINT "_KpiGroupTeams_AB_pkey" TO "kpi_group_teams_pkey";
ALTER TABLE "kpi_group_teams" RENAME CONSTRAINT "_KpiGroupTeams_A_fkey" TO "kpi_group_teams_kpi_group_id_fkey";
ALTER TABLE "kpi_group_teams" RENAME CONSTRAINT "_KpiGroupTeams_B_fkey" TO "kpi_group_teams_team_id_fkey";
ALTER INDEX "_KpiGroupTeams_B_index" RENAME TO "kpi_group_teams_team_id_idx";

-- _KpiGroupEmployeeGroups: A = employee_groups.id, B = kpi_groups.id
ALTER TABLE "_KpiGroupEmployeeGroups" RENAME TO "kpi_group_employee_groups";
ALTER TABLE "kpi_group_employee_groups" RENAME COLUMN "A" TO "employee_group_id";
ALTER TABLE "kpi_group_employee_groups" RENAME COLUMN "B" TO "kpi_group_id";
ALTER TABLE "kpi_group_employee_groups" RENAME CONSTRAINT "_KpiGroupEmployeeGroups_AB_pkey" TO "kpi_group_employee_groups_pkey";
ALTER TABLE "kpi_group_employee_groups" RENAME CONSTRAINT "_KpiGroupEmployeeGroups_A_fkey" TO "kpi_group_employee_groups_employee_group_id_fkey";
ALTER TABLE "kpi_group_employee_groups" RENAME CONSTRAINT "_KpiGroupEmployeeGroups_B_fkey" TO "kpi_group_employee_groups_kpi_group_id_fkey";
ALTER INDEX "_KpiGroupEmployeeGroups_B_index" RENAME TO "kpi_group_employee_groups_kpi_group_id_idx";

-- Index do 20260924000000_add_traffic_sync tạo lệch tên với schema; đưa về tên Prisma sinh ra.
ALTER INDEX "traffic_sync_run_items_run_status_id_idx" RENAME TO "traffic_sync_run_items_traffic_sync_run_id_result_status_id_idx";
