CREATE TYPE "SalaryRecordStatus" AS ENUM ('PENDING', 'WARNING', 'LOCKED', 'SUPERSEDED');
CREATE TYPE "SalaryComponentSource" AS ENUM ('MANUAL', 'SYSTEM');

CREATE TABLE "salary_records" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "payroll_period_id" INTEGER NOT NULL,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "parent_salary_record_id" INTEGER,
    "reward_rule_set_id" INTEGER NOT NULL,
    "revenue_reward_bracket_id" INTEGER,
    "base_salary_amount" DECIMAL(18,0) NOT NULL,
    "kpi_reward_amount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "okr_reward_amount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "revenue_amount_snapshot" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "commission_rate_percent_snapshot" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "commission_amount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "total_views_snapshot" BIGINT NOT NULL DEFAULT 0,
    "rpm_rate_per_1000_views_snapshot" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "rpm_reward_amount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "additional_component_amount" DECIMAL(18,0) NOT NULL DEFAULT 0,
    "total_salary_amount" DECIMAL(18,0) NOT NULL,
    "status" "SalaryRecordStatus" NOT NULL DEFAULT 'PENDING',
    "calculation_warnings" JSONB NOT NULL DEFAULT '[]',
    "calculated_by_user_id" UUID NOT NULL,
    "calculated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ,
    "locked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "salary_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "salary_record_kpi_items" (
    "id" SERIAL NOT NULL,
    "salary_record_id" INTEGER NOT NULL,
    "kpi_group_id" INTEGER NOT NULL,
    "kpi_group_name_snapshot" VARCHAR(200) NOT NULL,
    "progress_percent" DECIMAL(7,4) NOT NULL,
    "achievement_threshold_percent_snapshot" DECIMAL(5,2) NOT NULL,
    "reward_amount_snapshot" DECIMAL(18,0) NOT NULL,
    "is_achieved" BOOLEAN NOT NULL,
    "earned_amount" DECIMAL(18,0) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "salary_record_kpi_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "salary_record_okr_items" (
    "id" SERIAL NOT NULL,
    "salary_record_id" INTEGER NOT NULL,
    "employee_okr_id" INTEGER NOT NULL,
    "okr_title_snapshot" VARCHAR(250) NOT NULL,
    "progress_percent" DECIMAL(7,4) NOT NULL,
    "achievement_threshold_percent_snapshot" DECIMAL(5,2) NOT NULL,
    "reward_amount_snapshot" DECIMAL(18,0) NOT NULL,
    "is_achieved" BOOLEAN NOT NULL,
    "earned_amount" DECIMAL(18,0) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "salary_record_okr_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "salary_record_components" (
    "id" SERIAL NOT NULL,
    "salary_record_id" INTEGER NOT NULL,
    "component_code" VARCHAR(80),
    "component_name" VARCHAR(150) NOT NULL,
    "amount" DECIMAL(18,0) NOT NULL,
    "note" TEXT,
    "source" "SalaryComponentSource" NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "salary_record_components_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "salary_records_employee_id_payroll_period_id_version_number_key"
ON "salary_records"("employee_id", "payroll_period_id", "version_number");
CREATE INDEX "salary_records_payroll_period_id_status_idx" ON "salary_records"("payroll_period_id", "status");
CREATE INDEX "salary_records_parent_salary_record_id_idx" ON "salary_records"("parent_salary_record_id");
CREATE UNIQUE INDEX "salary_record_kpi_items_salary_record_id_kpi_group_id_key"
ON "salary_record_kpi_items"("salary_record_id", "kpi_group_id");
CREATE INDEX "salary_record_kpi_items_kpi_group_id_idx" ON "salary_record_kpi_items"("kpi_group_id");
CREATE UNIQUE INDEX "salary_record_okr_items_salary_record_id_employee_okr_id_key"
ON "salary_record_okr_items"("salary_record_id", "employee_okr_id");
CREATE INDEX "salary_record_okr_items_employee_okr_id_idx" ON "salary_record_okr_items"("employee_okr_id");
CREATE INDEX "salary_record_components_salary_record_id_idx" ON "salary_record_components"("salary_record_id");

ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_employee_id_fkey"
FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_payroll_period_id_fkey"
FOREIGN KEY ("payroll_period_id") REFERENCES "payroll_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_parent_salary_record_id_fkey"
FOREIGN KEY ("parent_salary_record_id") REFERENCES "salary_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_reward_rule_set_id_fkey"
FOREIGN KEY ("reward_rule_set_id") REFERENCES "reward_rule_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_revenue_reward_bracket_id_fkey"
FOREIGN KEY ("revenue_reward_bracket_id") REFERENCES "revenue_reward_brackets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_calculated_by_user_id_fkey"
FOREIGN KEY ("calculated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_approved_by_user_id_fkey"
FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "salary_record_kpi_items" ADD CONSTRAINT "salary_record_kpi_items_salary_record_id_fkey"
FOREIGN KEY ("salary_record_id") REFERENCES "salary_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "salary_record_kpi_items" ADD CONSTRAINT "salary_record_kpi_items_kpi_group_id_fkey"
FOREIGN KEY ("kpi_group_id") REFERENCES "kpi_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "salary_record_okr_items" ADD CONSTRAINT "salary_record_okr_items_salary_record_id_fkey"
FOREIGN KEY ("salary_record_id") REFERENCES "salary_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "salary_record_okr_items" ADD CONSTRAINT "salary_record_okr_items_employee_okr_id_fkey"
FOREIGN KEY ("employee_okr_id") REFERENCES "employee_okrs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "salary_record_components" ADD CONSTRAINT "salary_record_components_salary_record_id_fkey"
FOREIGN KEY ("salary_record_id") REFERENCES "salary_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "salary_record_components" ADD CONSTRAINT "salary_record_components_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
