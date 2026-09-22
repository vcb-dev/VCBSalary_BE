ALTER TABLE "employee_kpi_targets"
  ADD COLUMN "override_value" DECIMAL(18,4),
  ADD COLUMN "override_reason" TEXT,
  ADD COLUMN "overridden_by_user_id" UUID,
  ADD COLUMN "overridden_at" TIMESTAMPTZ;

ALTER TABLE "employee_kpi_targets"
  ADD CONSTRAINT "employee_kpi_targets_overridden_by_user_id_fkey"
  FOREIGN KEY ("overridden_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
