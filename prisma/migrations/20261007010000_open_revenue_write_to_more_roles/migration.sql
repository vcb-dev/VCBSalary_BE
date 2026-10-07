-- Nhập doanh thu chính thức không còn là quyền riêng của Kế toán. Quản trị và Quản lý duyệt là
-- vai trò toàn quyền nên có luôn; Trưởng nhóm nhập cho nhân sự trong team mình (scope TEAM).
-- Seed không bổ sung quyền mới cho role đã có quyền, nên cấp ở đây cho DB đang chạy.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" AS r
CROSS JOIN "permissions" AS p
WHERE r."code" IN ('ADMIN', 'MANAGER_APPROVER', 'LEADER')
  AND p."code" = 'revenue.write'
ON CONFLICT DO NOTHING;

UPDATE "roles"
SET "description" = 'Nhập doanh thu chính thức và tính lương'
WHERE "code" = 'ACCOUNTANT';
