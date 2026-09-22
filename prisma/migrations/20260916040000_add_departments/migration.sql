-- Add the Department -> Team -> Employee organization hierarchy.
CREATE TYPE "DepartmentStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "status" "DepartmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- AutomationGenVideo always belongs to Marketing. Existing manually-created teams are
-- retained under a holding department so this migration never loses organization data.
INSERT INTO "departments" ("code", "name", "status")
VALUES
    ('MARKETING', 'Marketing', 'ACTIVE'),
    ('UNASSIGNED', 'Chưa phân loại', 'ACTIVE');

ALTER TABLE "teams" ADD COLUMN "department_id" INTEGER;

UPDATE "teams"
SET "department_id" = (
    SELECT "id"
    FROM "departments"
    WHERE "code" = CASE
        WHEN "teams"."source_system" = 'AUTOMATION_GEN_VIDEO' THEN 'MARKETING'
        ELSE 'UNASSIGNED'
    END
);

ALTER TABLE "teams" ALTER COLUMN "department_id" SET NOT NULL;

CREATE INDEX "teams_department_id_idx" ON "teams"("department_id");

ALTER TABLE "teams"
ADD CONSTRAINT "teams_department_id_fkey"
FOREIGN KEY ("department_id") REFERENCES "departments"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
