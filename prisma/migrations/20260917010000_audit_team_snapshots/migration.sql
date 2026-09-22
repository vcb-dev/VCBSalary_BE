ALTER TABLE "audit_logs"
  ADD COLUMN "actor_team_id_snapshot" INTEGER,
  ADD COLUMN "target_team_id_snapshot" INTEGER;

UPDATE "audit_logs" AS a
SET "actor_team_id_snapshot" = COALESCE(
  (
    SELECT s."team_id_snapshot"
    FROM "users" AS u
    JOIN "payroll_period_employee_snapshots" AS s
      ON s."employee_id" = u."employee_id"
     AND s."payroll_period_id" = a."payroll_period_id"
    WHERE u."id" = a."actor_user_id"
  ),
  (
    SELECT e."team_id"
    FROM "users" AS u
    JOIN "employees" AS e ON e."id" = u."employee_id"
    WHERE u."id" = a."actor_user_id"
  )
);

UPDATE "audit_logs" AS a
SET "target_team_id_snapshot" = COALESCE(
  (
    SELECT s."team_id_snapshot"
    FROM "payroll_period_employee_snapshots" AS s
    WHERE s."payroll_period_id" = a."payroll_period_id"
      AND s."employee_id" = a."target_employee_id"
  ),
  (
    SELECT e."team_id"
    FROM "employees" AS e
    WHERE e."id" = a."target_employee_id"
  )
);

CREATE INDEX "audit_logs_actor_team_id_snapshot_created_at_idx"
  ON "audit_logs"("actor_team_id_snapshot", "created_at" DESC);
CREATE INDEX "audit_logs_target_team_id_snapshot_created_at_idx"
  ON "audit_logs"("target_team_id_snapshot", "created_at" DESC);

-- revenue.write là quyền độc quyền của ACCOUNTANT theo ma trận nghiệp vụ.
DELETE FROM "role_permissions" AS rp
USING "roles" AS r, "permissions" AS p
WHERE rp."role_id" = r."id"
  AND rp."permission_id" = p."id"
  AND p."code" = 'revenue.write'
  AND r."code" <> 'ACCOUNTANT';

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" AS r
CROSS JOIN "permissions" AS p
WHERE r."code" = 'ACCOUNTANT' AND p."code" = 'revenue.write'
ON CONFLICT DO NOTHING;
