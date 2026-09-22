CREATE TABLE "employee_kpi_reward_rates" (
  "id" SERIAL NOT NULL,
  "employee_id" INTEGER NOT NULL,
  "kpi_group_id" INTEGER NOT NULL,
  "reward_amount" DECIMAL(18,0) NOT NULL,
  "effective_from" DATE NOT NULL,
  "effective_to" DATE,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "employee_kpi_reward_rates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "employee_kpi_reward_rates_reward_amount_check" CHECK ("reward_amount" >= 0),
  CONSTRAINT "employee_kpi_reward_rates_effective_range_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);

CREATE UNIQUE INDEX "employee_kpi_reward_rates_employee_id_kpi_group_id_effective_from_key"
ON "employee_kpi_reward_rates"("employee_id", "kpi_group_id", "effective_from");

CREATE INDEX "employee_kpi_reward_rates_employee_id_effective_from_idx"
ON "employee_kpi_reward_rates"("employee_id", "effective_from" DESC);

CREATE INDEX "employee_kpi_reward_rates_kpi_group_id_idx"
ON "employee_kpi_reward_rates"("kpi_group_id");

ALTER TABLE "employee_kpi_reward_rates"
ADD CONSTRAINT "employee_kpi_reward_rates_employee_id_fkey"
FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employee_kpi_reward_rates"
ADD CONSTRAINT "employee_kpi_reward_rates_kpi_group_id_fkey"
FOREIGN KEY ("kpi_group_id") REFERENCES "kpi_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "employee_kpi_reward_rates"
ADD CONSTRAINT "employee_kpi_reward_rates_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
