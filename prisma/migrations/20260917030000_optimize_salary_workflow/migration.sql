-- Salary calculation checks unresolved sync conflicts for each employee. Without this index,
-- every employee calculation scans the entire sync-item history.
CREATE INDEX "kpi_sync_run_items_employee_status_id_idx"
ON "kpi_sync_run_items"("employee_id", "result_status", "id" DESC);
