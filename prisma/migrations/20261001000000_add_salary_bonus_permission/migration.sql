-- Thưởng thêm là khoản thủ công cộng thẳng vào tổng lương (bảng salary_record_components đã có).
-- Seed không bổ sung quyền mới cho role đã có quyền, nên cấp ở đây cho DB đang chạy.
INSERT INTO "permissions" ("code", "name")
VALUES ('salary.bonus', 'Thêm thưởng thêm vào bảng lương')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" AS r
CROSS JOIN "permissions" AS p
WHERE r."code" IN ('ADMIN', 'MANAGER_APPROVER', 'LEADER')
  AND p."code" = 'salary.bonus'
ON CONFLICT DO NOTHING;
