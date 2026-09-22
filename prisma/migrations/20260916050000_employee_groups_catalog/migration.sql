-- Chuyển nhóm nghiệp vụ từ enum cứng (EDITOR/CONTENT_CREATOR — chỉ đúng với Marketing) sang danh
-- mục quản lý được theo phòng ban, để phòng ban khác cũng dùng được cơ chế tự gán KPI khi mở kỳ.

CREATE TYPE "EmployeeGroupStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TABLE "employee_groups" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "department_id" INTEGER,
    "default_role_id" INTEGER,
    "job_title_keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "EmployeeGroupStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "employee_groups_code_key" ON "employee_groups"("code");
CREATE INDEX "employee_groups_department_id_idx" ON "employee_groups"("department_id");

ALTER TABLE "employee_groups" ADD CONSTRAINT "employee_groups_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "employee_groups" ADD CONSTRAINT "employee_groups_default_role_id_fkey"
    FOREIGN KEY ("default_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hai nhóm cũ thuộc Marketing. `default_role_id` vật chất hóa quy ước ngầm trước đây của
-- users.service (role có code trùng mã nhóm nghiệp vụ) để hành vi suy vai trò mặc định không đổi.
-- `job_title_keywords` giữ nguyên bộ từ khóa của regex cũ trong employees.service (khớp chuỗi con
-- trên chức danh đã bỏ dấu + viết hoa) nên việc tự đoán nhóm theo chức danh không đổi kết quả.
INSERT INTO "employee_groups" ("code", "name", "description", "department_id", "default_role_id", "job_title_keywords")
SELECT
    v.code,
    v.name,
    v.description,
    (SELECT "id" FROM "departments" WHERE "code" = 'MARKETING'),
    (SELECT "id" FROM "roles" WHERE "code" = v.code),
    v.keywords
FROM (VALUES
    ('EDITOR', 'Editor', 'Nhân sự dựng video của Marketing, đồng bộ từ AutomationGenVideo.',
     ARRAY['EDITOR', 'BIEN TAP', 'DUNG PHIM']),
    ('CONTENT_CREATOR', 'Content Creator', 'Vai trò bổ sung cho nhân sự Marketing sản xuất nội dung.',
     ARRAY['CONTENT CREATOR', 'CREATOR', 'SANG TAO NOI DUNG'])
) AS v(code, name, description, keywords)
ON CONFLICT ("code") DO NOTHING;

CREATE TABLE "_EmployeeEmployeeGroups" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_EmployeeEmployeeGroups_AB_pkey" PRIMARY KEY ("A","B")
);
CREATE INDEX "_EmployeeEmployeeGroups_B_index" ON "_EmployeeEmployeeGroups"("B");
ALTER TABLE "_EmployeeEmployeeGroups" ADD CONSTRAINT "_EmployeeEmployeeGroups_A_fkey"
    FOREIGN KEY ("A") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_EmployeeEmployeeGroups" ADD CONSTRAINT "_EmployeeEmployeeGroups_B_fkey"
    FOREIGN KEY ("B") REFERENCES "employee_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "_KpiGroupEmployeeGroups" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_KpiGroupEmployeeGroups_AB_pkey" PRIMARY KEY ("A","B")
);
CREATE INDEX "_KpiGroupEmployeeGroups_B_index" ON "_KpiGroupEmployeeGroups"("B");
ALTER TABLE "_KpiGroupEmployeeGroups" ADD CONSTRAINT "_KpiGroupEmployeeGroups_A_fkey"
    FOREIGN KEY ("A") REFERENCES "employee_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_KpiGroupEmployeeGroups" ADD CONSTRAINT "_KpiGroupEmployeeGroups_B_fkey"
    FOREIGN KEY ("B") REFERENCES "kpi_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: mỗi phần tử trong mảng enum cũ thành một dòng quan hệ. Mảng rỗng không sinh dòng nào.
INSERT INTO "_EmployeeEmployeeGroups" ("A", "B")
SELECT e."id", g."id"
FROM "employees" e
CROSS JOIN LATERAL unnest(e."employee_groups") AS grp
JOIN "employee_groups" g ON g."code" = grp::TEXT
ON CONFLICT DO NOTHING;

INSERT INTO "_KpiGroupEmployeeGroups" ("A", "B")
SELECT g."id", kg."id"
FROM "kpi_groups" kg
CROSS JOIN LATERAL unnest(kg."applicable_employee_groups") AS grp
JOIN "employee_groups" g ON g."code" = grp::TEXT
ON CONFLICT DO NOTHING;

-- Snapshot của kỳ đã chốt chuyển sang TEXT[] TẠI CHỖ (không drop/add cột) để giữ nguyên lịch sử.
ALTER TABLE "payroll_period_employee_snapshots" ALTER COLUMN "employee_groups_snapshot" DROP DEFAULT;
ALTER TABLE "payroll_period_employee_snapshots"
    ALTER COLUMN "employee_groups_snapshot" TYPE TEXT[] USING "employee_groups_snapshot"::TEXT[];
ALTER TABLE "payroll_period_employee_snapshots"
    ALTER COLUMN "employee_groups_snapshot" SET DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "employees" DROP COLUMN "employee_groups";
ALTER TABLE "kpi_groups" DROP COLUMN "applicable_employee_groups";

DROP TYPE "EmployeeGroup";
