CREATE TYPE "KpiSyncStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED');
CREATE TYPE "KpiSyncItemStatus" AS ENUM ('SUCCESS', 'SKIPPED', 'FAILED', 'CONFLICT');
CREATE TYPE "KpiSyncRecordKind" AS ENUM ('TARGET', 'ACTUAL');
CREATE TYPE "KpiValueDataSource" AS ENUM ('MANUAL', 'AUTOMATION_GEN_VIDEO');

ALTER TABLE "employee_kpi_targets"
  ADD COLUMN "data_source" "KpiValueDataSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "synced_at" TIMESTAMPTZ;

ALTER TABLE "employee_kpi_actuals"
  ADD COLUMN "data_source" "KpiValueDataSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "synced_at" TIMESTAMPTZ,
  ADD COLUMN "requires_manual_entry" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "manual_entered_at" TIMESTAMPTZ,
  ADD COLUMN "sync_message" TEXT;

-- Các mã này là contract chính thức từ AutomationGenVideo. Dữ liệu cũ có thể đã được seed với
-- INTERNAL nên cần chuyển nguồn để bộ mapping đồng bộ nhận diện đúng.
UPDATE "kpi_groups"
SET "data_source" = 'AUTOMATION_GEN_VIDEO'
WHERE "code" IN ('VIDEO_PRODUCTION', 'CONTENT', 'PRODUCT', 'AGV_CONTENT_CREATOR_MONTHLY');

CREATE TABLE "kpi_sync_runs" (
  "id" UUID NOT NULL,
  "external_team_id" UUID NOT NULL,
  "payroll_period_id" INTEGER NOT NULL,
  "month" VARCHAR(7) NOT NULL,
  "triggered_by_user_id" UUID NOT NULL,
  "status" "KpiSyncStatus" NOT NULL DEFAULT 'RUNNING',
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ,
  "received_records" INTEGER NOT NULL DEFAULT 0,
  "successful_records" INTEGER NOT NULL DEFAULT 0,
  "skipped_records" INTEGER NOT NULL DEFAULT 0,
  "conflict_records" INTEGER NOT NULL DEFAULT 0,
  "failed_records" INTEGER NOT NULL DEFAULT 0,
  "manual_entry_count" INTEGER NOT NULL DEFAULT 0,
  "warning_count" INTEGER NOT NULL DEFAULT 0,
  "source_warnings" JSONB,
  "error_summary" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kpi_sync_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "kpi_sync_runs_payroll_period_id_fkey" FOREIGN KEY ("payroll_period_id") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "kpi_sync_runs_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "kpi_sync_run_items" (
  "id" SERIAL NOT NULL,
  "kpi_sync_run_id" UUID NOT NULL,
  "external_record_key" VARCHAR(300) NOT NULL,
  "external_user_id" UUID,
  "external_employee_code" VARCHAR(50),
  "employee_id" INTEGER,
  "kpi_item_id" INTEGER,
  "employee_kpi_target_id" INTEGER,
  "employee_kpi_actual_id" INTEGER,
  "group_code" VARCHAR(80) NOT NULL,
  "metric_code" VARCHAR(80) NOT NULL,
  "record_kind" "KpiSyncRecordKind" NOT NULL,
  "result_status" "KpiSyncItemStatus" NOT NULL,
  "previous_value" DECIMAL(18,4),
  "incoming_value" DECIMAL(18,4),
  "applied_value" DECIMAL(18,4),
  "has_conflict" BOOLEAN NOT NULL DEFAULT false,
  "manual_entry_required" BOOLEAN NOT NULL DEFAULT false,
  "message" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kpi_sync_run_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "kpi_sync_run_items_kpi_sync_run_id_fkey" FOREIGN KEY ("kpi_sync_run_id") REFERENCES "kpi_sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "kpi_sync_run_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "kpi_sync_run_items_kpi_item_id_fkey" FOREIGN KEY ("kpi_item_id") REFERENCES "kpi_items"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "kpi_sync_run_items_employee_kpi_target_id_fkey" FOREIGN KEY ("employee_kpi_target_id") REFERENCES "employee_kpi_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "kpi_sync_run_items_employee_kpi_actual_id_fkey" FOREIGN KEY ("employee_kpi_actual_id") REFERENCES "employee_kpi_actuals"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "kpi_sync_runs_started_at_idx" ON "kpi_sync_runs"("started_at" DESC);
CREATE INDEX "kpi_sync_runs_external_team_id_month_status_idx" ON "kpi_sync_runs"("external_team_id", "month", "status");
CREATE INDEX "kpi_sync_runs_payroll_period_id_idx" ON "kpi_sync_runs"("payroll_period_id");
CREATE INDEX "kpi_sync_run_items_kpi_sync_run_id_idx" ON "kpi_sync_run_items"("kpi_sync_run_id");
CREATE INDEX "kpi_sync_run_items_employee_id_kpi_item_id_idx" ON "kpi_sync_run_items"("employee_id", "kpi_item_id");
CREATE INDEX "kpi_sync_run_items_result_status_manual_entry_required_idx" ON "kpi_sync_run_items"("result_status", "manual_entry_required");
