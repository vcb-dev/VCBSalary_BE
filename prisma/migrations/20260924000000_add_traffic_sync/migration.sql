CREATE TYPE "TrafficDataSource" AS ENUM ('MANUAL', 'AUTOMATION_GEN_VIDEO');
CREATE TYPE "TrafficSyncStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED');
CREATE TYPE "TrafficSyncItemStatus" AS ENUM ('SUCCESS', 'SKIPPED', 'FAILED', 'CONFLICT');

-- Traffic là số LUỸ KẾ tới một ngày báo cáo, không phải lượng phát sinh trong kỳ. Lưu kèm
-- source_report_date để về sau còn đối chiếu được con số này "tính tới ngày nào".
ALTER TABLE "employee_traffic_records"
  ADD COLUMN "data_source" "TrafficDataSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "synced_at" TIMESTAMPTZ,
  ADD COLUMN "source_report_date" DATE,
  ADD COLUMN "source_channel" VARCHAR(255);

CREATE TABLE "traffic_sync_runs" (
  "id" UUID NOT NULL,
  "payroll_period_id" INTEGER NOT NULL,
  "date_from" DATE NOT NULL,
  "date_to" DATE NOT NULL,
  "external_team_name" VARCHAR(150),
  "triggered_by_user_id" UUID NOT NULL,
  "status" "TrafficSyncStatus" NOT NULL DEFAULT 'RUNNING',
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ,
  "received_rows" INTEGER NOT NULL DEFAULT 0,
  "matched_employees" INTEGER NOT NULL DEFAULT 0,
  "unmatched_rows" INTEGER NOT NULL DEFAULT 0,
  "successful_records" INTEGER NOT NULL DEFAULT 0,
  "skipped_records" INTEGER NOT NULL DEFAULT 0,
  "conflict_records" INTEGER NOT NULL DEFAULT 0,
  "failed_records" INTEGER NOT NULL DEFAULT 0,
  "warning_count" INTEGER NOT NULL DEFAULT 0,
  "source_warnings" JSONB,
  "error_summary" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "traffic_sync_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "traffic_sync_runs_payroll_period_id_fkey" FOREIGN KEY ("payroll_period_id") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "traffic_sync_runs_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "traffic_sync_run_items" (
  "id" SERIAL NOT NULL,
  "traffic_sync_run_id" UUID NOT NULL,
  "external_record_key" VARCHAR(300) NOT NULL,
  "external_email" VARCHAR(255),
  "external_name" VARCHAR(200),
  "external_team" VARCHAR(150),
  "employee_id" INTEGER,
  "platform" "TrafficPlatform",
  "source_report_date" DATE,
  "employee_traffic_record_id" INTEGER,
  "result_status" "TrafficSyncItemStatus" NOT NULL,
  "previous_views" BIGINT,
  "incoming_views" BIGINT,
  "applied_views" BIGINT,
  "has_conflict" BOOLEAN NOT NULL DEFAULT false,
  "message" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "traffic_sync_run_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "traffic_sync_run_items_traffic_sync_run_id_fkey" FOREIGN KEY ("traffic_sync_run_id") REFERENCES "traffic_sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "traffic_sync_run_items_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "traffic_sync_run_items_employee_traffic_record_id_fkey" FOREIGN KEY ("employee_traffic_record_id") REFERENCES "employee_traffic_records"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "traffic_sync_runs_started_at_idx" ON "traffic_sync_runs"("started_at" DESC);
CREATE INDEX "traffic_sync_runs_payroll_period_id_status_idx" ON "traffic_sync_runs"("payroll_period_id", "status");

-- Chặn hai lượt đồng bộ traffic chạy song song trên cùng một kỳ lương ở tầng DB.
CREATE UNIQUE INDEX "traffic_sync_runs_one_running_per_period_idx"
ON "traffic_sync_runs"("payroll_period_id")
WHERE "status" = 'RUNNING';

CREATE INDEX "traffic_sync_run_items_run_status_id_idx" ON "traffic_sync_run_items"("traffic_sync_run_id", "result_status", "id");
CREATE INDEX "traffic_sync_run_items_employee_id_idx" ON "traffic_sync_run_items"("employee_id");
CREATE INDEX "traffic_sync_run_items_employee_traffic_record_id_idx" ON "traffic_sync_run_items"("employee_traffic_record_id");
