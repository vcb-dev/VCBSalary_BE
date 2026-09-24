CREATE TYPE "PerformanceGoalType" AS ENUM ('KPI', 'OKR');
CREATE TYPE "PerformanceGoalDirection" AS ENUM ('AT_LEAST', 'AT_MOST');
CREATE TYPE "PerformanceGoalMetricType" AS ENUM ('NUMBER', 'PERCENT', 'BOOLEAN');

ALTER TABLE "employee_okrs"
    ADD COLUMN "team_id" INTEGER,
    ADD COLUMN "goal_type" "PerformanceGoalType" NOT NULL DEFAULT 'OKR',
    ADD COLUMN "metric_type" "PerformanceGoalMetricType" NOT NULL DEFAULT 'NUMBER',
    ADD COLUMN "direction" "PerformanceGoalDirection" NOT NULL DEFAULT 'AT_LEAST',
    ADD COLUMN "actual_missing" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "data_source" "KpiValueDataSource" NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN "external_item_id" UUID,
    ADD COLUMN "external_revision" INTEGER,
    ADD COLUMN "source_updated_at" TIMESTAMPTZ,
    ADD COLUMN "synced_at" TIMESTAMPTZ,
    ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "employee_okrs_external_item_id_key"
    ON "employee_okrs"("external_item_id");
CREATE INDEX "employee_okrs_team_id_payroll_period_id_is_active_idx"
    ON "employee_okrs"("team_id", "payroll_period_id", "is_active");

ALTER TABLE "employee_okrs"
    ADD CONSTRAINT "employee_okrs_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "kpi_sync_run_items"
    ADD COLUMN "employee_okr_id" INTEGER;
CREATE INDEX "kpi_sync_run_items_employee_okr_id_idx"
    ON "kpi_sync_run_items"("employee_okr_id");
ALTER TABLE "kpi_sync_run_items"
    ADD CONSTRAINT "kpi_sync_run_items_employee_okr_id_fkey"
    FOREIGN KEY ("employee_okr_id") REFERENCES "employee_okrs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "salary_record_okr_items"
    ADD COLUMN "goal_type_snapshot" "PerformanceGoalType" NOT NULL DEFAULT 'OKR';
