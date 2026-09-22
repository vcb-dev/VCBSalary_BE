BEGIN;

-- Expand the organization model without removing the legacy employees.team_id primary-team field.
CREATE TABLE "external_employee_identities" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "source_system" VARCHAR(30) NOT NULL,
    "external_user_id" UUID NOT NULL,
    "external_employee_code" VARCHAR(100),
    "last_known_email" VARCHAR(255),
    "last_known_name" VARCHAR(200),
    "last_synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "external_employee_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_employee_identities_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "external_employee_identities_source_system_external_user_id_key"
  ON "external_employee_identities"("source_system", "external_user_id");
CREATE INDEX "external_employee_identities_employee_id_idx"
  ON "external_employee_identities"("employee_id");
CREATE INDEX "external_employee_identities_last_known_email_idx"
  ON "external_employee_identities"("last_known_email");

INSERT INTO "external_employee_identities" (
  "employee_id", "source_system", "external_user_id", "last_known_email",
  "last_known_name", "last_synced_at"
)
SELECT e."id", COALESCE(e."source_system", 'AUTOMATION_GEN_VIDEO'), e."external_id",
       u."email", e."full_name", COALESCE(e."last_synced_at", CURRENT_TIMESTAMP)
FROM "employees" e
LEFT JOIN "users" u ON u."employee_id" = e."id"
WHERE e."external_id" IS NOT NULL
ON CONFLICT ("source_system", "external_user_id") DO NOTHING;

CREATE TABLE "employee_team_memberships" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "team_id" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "default_salary_weight_percent" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "leader_employee_id" INTEGER,
    "manager_employee_id" INTEGER,
    "joined_at" DATE,
    "left_at" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "source_system" VARCHAR(30),
    "external_team_id" UUID,
    "last_synced_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_team_memberships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "employee_team_memberships_employee_id_fkey"
      FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "employee_team_memberships_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "employee_team_memberships_leader_employee_id_fkey"
      FOREIGN KEY ("leader_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "employee_team_memberships_manager_employee_id_fkey"
      FOREIGN KEY ("manager_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "employee_team_memberships_weight_check"
      CHECK ("default_salary_weight_percent" >= 0 AND "default_salary_weight_percent" <= 100)
);

CREATE UNIQUE INDEX "employee_team_memberships_employee_id_team_id_key"
  ON "employee_team_memberships"("employee_id", "team_id");
CREATE UNIQUE INDEX "employee_team_memberships_one_active_primary_key"
  ON "employee_team_memberships"("employee_id")
  WHERE "is_primary" = true AND "is_active" = true;
CREATE INDEX "employee_team_memberships_team_id_is_active_idx"
  ON "employee_team_memberships"("team_id", "is_active");
CREATE INDEX "employee_team_memberships_employee_id_is_active_idx"
  ON "employee_team_memberships"("employee_id", "is_active");
CREATE INDEX "employee_team_memberships_leader_employee_id_idx"
  ON "employee_team_memberships"("leader_employee_id");
CREATE INDEX "employee_team_memberships_manager_employee_id_idx"
  ON "employee_team_memberships"("manager_employee_id");

INSERT INTO "employee_team_memberships" (
  "employee_id", "team_id", "is_primary", "default_salary_weight_percent",
  "leader_employee_id", "manager_employee_id", "joined_at", "left_at", "is_active",
  "source_system", "external_team_id", "last_synced_at"
)
SELECT e."id", e."team_id", true, 100, e."leader_employee_id", e."manager_employee_id",
       e."joined_at", e."left_at", (e."employment_status" = 'ACTIVE'), e."source_system",
       t."external_id", e."last_synced_at"
FROM "employees" e
JOIN "teams" t ON t."id" = e."team_id"
ON CONFLICT ("employee_id", "team_id") DO NOTHING;

CREATE TABLE "payroll_period_employee_team_snapshots" (
    "id" SERIAL NOT NULL,
    "payroll_period_id" INTEGER NOT NULL,
    "employee_snapshot_id" INTEGER NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "membership_id" INTEGER,
    "team_id" INTEGER NOT NULL,
    "team_code_snapshot" VARCHAR(50) NOT NULL,
    "team_name_snapshot" VARCHAR(150) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "salary_weight_percent" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "leader_employee_id_snapshot" INTEGER,
    "leader_name_snapshot" VARCHAR(200),
    "manager_employee_id_snapshot" INTEGER,
    "manager_name_snapshot" VARCHAR(200),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payroll_period_employee_team_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payroll_period_employee_team_snapshots_payroll_period_id_fkey" FOREIGN KEY ("payroll_period_id") REFERENCES "payroll_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "payroll_period_employee_team_snapshots_employee_snapshot_i_fkey" FOREIGN KEY ("employee_snapshot_id") REFERENCES "payroll_period_employee_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "payroll_period_employee_team_snapshots_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payroll_period_employee_team_snapshots_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "employee_team_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "payroll_period_employee_team_snapshots_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payroll_period_employee_team_snapshots_leader_employee_id__fkey" FOREIGN KEY ("leader_employee_id_snapshot") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "payroll_period_employee_team_snapshots_manager_employee_id_fkey" FOREIGN KEY ("manager_employee_id_snapshot") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "period_team_snapshots_weight_check" CHECK ("salary_weight_percent" >= 0 AND "salary_weight_percent" <= 100)
);

CREATE UNIQUE INDEX "payroll_period_employee_team_snapshots_payroll_period_id_em_key"
  ON "payroll_period_employee_team_snapshots"("payroll_period_id", "employee_id", "team_id");
CREATE INDEX "payroll_period_employee_team_snapshots_payroll_period_id_te_idx"
  ON "payroll_period_employee_team_snapshots"("payroll_period_id", "team_id");
CREATE INDEX "payroll_period_employee_team_snapshots_employee_snapshot_id_idx"
  ON "payroll_period_employee_team_snapshots"("employee_snapshot_id");

INSERT INTO "payroll_period_employee_team_snapshots" (
  "payroll_period_id", "employee_snapshot_id", "employee_id", "membership_id", "team_id",
  "team_code_snapshot", "team_name_snapshot", "is_primary", "salary_weight_percent",
  "leader_employee_id_snapshot", "leader_name_snapshot",
  "manager_employee_id_snapshot", "manager_name_snapshot", "created_at"
)
SELECT s."payroll_period_id", s."id", s."employee_id", m."id", s."team_id_snapshot",
       COALESCE(s."team_code_snapshot", t."code"), COALESCE(s."team_name_snapshot", t."name"),
       true, 100, s."leader_employee_id_snapshot", s."leader_name_snapshot",
       s."manager_employee_id_snapshot", s."manager_name_snapshot", s."created_at"
FROM "payroll_period_employee_snapshots" s
JOIN "teams" t ON t."id" = s."team_id_snapshot"
LEFT JOIN "employee_team_memberships" m
  ON m."employee_id" = s."employee_id" AND m."team_id" = s."team_id_snapshot"
WHERE s."team_id_snapshot" IS NOT NULL
ON CONFLICT ("payroll_period_id", "employee_id", "team_id") DO NOTHING;

-- Team-scope KPI rows. Add nullable, backfill, then enforce NOT NULL to keep the migration safe.
ALTER TABLE "employee_kpi_targets" ADD COLUMN "team_id" INTEGER;
ALTER TABLE "employee_kpi_assignments" ADD COLUMN "team_id" INTEGER;
ALTER TABLE "employee_kpi_actuals" ADD COLUMN "team_id" INTEGER;
ALTER TABLE "kpi_sync_run_items" ADD COLUMN "team_id" INTEGER;

UPDATE "employee_kpi_targets" k
SET "team_id" = COALESCE(
  (SELECT s."team_id_snapshot" FROM "payroll_period_employee_snapshots" s
   WHERE s."employee_id" = k."employee_id" AND s."payroll_period_id" = k."payroll_period_id"),
  e."team_id"
)
FROM "employees" e
WHERE e."id" = k."employee_id";

UPDATE "employee_kpi_assignments" k
SET "team_id" = COALESCE(
  (SELECT s."team_id_snapshot" FROM "payroll_period_employee_snapshots" s
   WHERE s."employee_id" = k."employee_id" AND s."payroll_period_id" = k."payroll_period_id"),
  e."team_id"
)
FROM "employees" e
WHERE e."id" = k."employee_id";

UPDATE "employee_kpi_actuals" k
SET "team_id" = COALESCE(
  (SELECT s."team_id_snapshot" FROM "payroll_period_employee_snapshots" s
   WHERE s."employee_id" = k."employee_id" AND s."payroll_period_id" = k."payroll_period_id"),
  e."team_id"
)
FROM "employees" e
WHERE e."id" = k."employee_id";

UPDATE "kpi_sync_run_items" i
SET "team_id" = COALESCE(
  (SELECT t."id" FROM "teams" t WHERE t."external_id" = r."external_team_id"),
  (SELECT e."team_id" FROM "employees" e WHERE e."id" = i."employee_id")
)
FROM "kpi_sync_runs" r
WHERE r."id" = i."kpi_sync_run_id";

ALTER TABLE "employee_kpi_targets" ALTER COLUMN "team_id" SET NOT NULL;
ALTER TABLE "employee_kpi_assignments" ALTER COLUMN "team_id" SET NOT NULL;
ALTER TABLE "employee_kpi_actuals" ALTER COLUMN "team_id" SET NOT NULL;

ALTER TABLE "employee_kpi_targets" ADD CONSTRAINT "employee_kpi_targets_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_kpi_assignments" ADD CONSTRAINT "employee_kpi_assignments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_kpi_actuals" ADD CONSTRAINT "employee_kpi_actuals_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "kpi_sync_run_items" ADD CONSTRAINT "kpi_sync_run_items_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "employee_kpi_targets" DROP CONSTRAINT IF EXISTS "employee_kpi_targets_employee_id_kpi_item_id_payroll_period_key";
ALTER TABLE "employee_kpi_assignments" DROP CONSTRAINT IF EXISTS "employee_kpi_assignments_employee_id_kpi_group_id_payroll_period_key";
ALTER TABLE "employee_kpi_actuals" DROP CONSTRAINT IF EXISTS "employee_kpi_actuals_employee_id_kpi_item_id_payroll_period_key";
DROP INDEX IF EXISTS "employee_kpi_targets_employee_id_kpi_item_id_payroll_period_key";
DROP INDEX IF EXISTS "employee_kpi_assignments_employee_id_kpi_group_id_payroll_period_key";
DROP INDEX IF EXISTS "employee_kpi_actuals_employee_id_kpi_item_id_payroll_period_key";

CREATE UNIQUE INDEX "employee_kpi_targets_employee_id_team_id_kpi_item_id_payrol_key"
  ON "employee_kpi_targets"("employee_id", "team_id", "kpi_item_id", "payroll_period_id");
CREATE UNIQUE INDEX "employee_kpi_assignments_employee_id_team_id_kpi_group_id_p_key"
  ON "employee_kpi_assignments"("employee_id", "team_id", "kpi_group_id", "payroll_period_id");
CREATE UNIQUE INDEX "employee_kpi_actuals_employee_id_team_id_kpi_item_id_payrol_key"
  ON "employee_kpi_actuals"("employee_id", "team_id", "kpi_item_id", "payroll_period_id");
CREATE INDEX "employee_kpi_targets_employee_id_payroll_period_id_team_id_idx" ON "employee_kpi_targets"("employee_id", "payroll_period_id", "team_id");
CREATE INDEX "employee_kpi_assignments_payroll_period_id_employee_id_team_idx" ON "employee_kpi_assignments"("payroll_period_id", "employee_id", "team_id");
CREATE INDEX "employee_kpi_actuals_employee_id_payroll_period_id_team_id_idx" ON "employee_kpi_actuals"("employee_id", "payroll_period_id", "team_id");
CREATE INDEX "kpi_sync_run_items_team_id_employee_id_idx" ON "kpi_sync_run_items"("team_id", "employee_id");

-- Keep a team/weight breakdown in every immutable salary KPI snapshot.
ALTER TABLE "salary_record_kpi_items" ADD COLUMN "team_id" INTEGER;
ALTER TABLE "salary_record_kpi_items" ADD COLUMN "team_name_snapshot" VARCHAR(150);
ALTER TABLE "salary_record_kpi_items" ADD COLUMN "salary_weight_percent_snapshot" DECIMAL(5,2) NOT NULL DEFAULT 100;

UPDATE "salary_record_kpi_items" i
SET "team_id" = s."team_id_snapshot",
    "team_name_snapshot" = COALESCE(s."team_name_snapshot", t."name")
FROM "salary_records" r
JOIN "payroll_period_employee_snapshots" s
  ON s."payroll_period_id" = r."payroll_period_id" AND s."employee_id" = r."employee_id"
LEFT JOIN "teams" t ON t."id" = s."team_id_snapshot"
WHERE r."id" = i."salary_record_id";

ALTER TABLE "salary_record_kpi_items" ALTER COLUMN "team_id" SET NOT NULL;
ALTER TABLE "salary_record_kpi_items" ALTER COLUMN "team_name_snapshot" SET NOT NULL;
ALTER TABLE "salary_record_kpi_items" ADD CONSTRAINT "salary_record_kpi_items_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "salary_record_kpi_items" ADD CONSTRAINT "salary_record_kpi_items_weight_check" CHECK ("salary_weight_percent_snapshot" >= 0 AND "salary_weight_percent_snapshot" <= 100);
ALTER TABLE "salary_record_kpi_items" DROP CONSTRAINT IF EXISTS "salary_record_kpi_items_salary_record_id_kpi_group_id_key";
DROP INDEX IF EXISTS "salary_record_kpi_items_salary_record_id_kpi_group_id_key";
CREATE UNIQUE INDEX "salary_record_kpi_items_salary_record_id_team_id_kpi_group__key"
  ON "salary_record_kpi_items"("salary_record_id", "team_id", "kpi_group_id");

COMMIT;
