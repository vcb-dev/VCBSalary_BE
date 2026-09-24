ALTER TABLE "kpi_items"
    ADD COLUMN "metric_type" "PerformanceGoalMetricType" NOT NULL DEFAULT 'NUMBER',
    ADD COLUMN "direction" "PerformanceGoalDirection" NOT NULL DEFAULT 'AT_LEAST',
    ADD COLUMN "external_item_id" UUID,
    ADD COLUMN "external_revision" INTEGER,
    ADD COLUMN "source_updated_at" TIMESTAMPTZ;

CREATE UNIQUE INDEX "kpi_items_external_item_id_key"
    ON "kpi_items"("external_item_id");

-- KPI linh hoạt từ contract cũ từng được lưu chung trong employee_okrs. Không xóa để bảo toàn
-- lịch sử/audit; ngừng kích hoạt để lần sync contract 2.0 tạo lại dưới dạng KpiItem đúng nhóm.
UPDATE "employee_okrs"
SET "is_active" = false,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "goal_type" = 'KPI'
  AND "data_source" = 'AUTOMATION_GEN_VIDEO';
