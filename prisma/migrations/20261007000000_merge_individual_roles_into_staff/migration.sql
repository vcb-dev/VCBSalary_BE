-- EDITOR và CONTENT_CREATOR có đúng một bộ quyền "tự xem/xác nhận dữ liệu của mình", chỉ là bản
-- soi gương của 2 nhóm nghiệp vụ cùng tên. Gộp thành một vai trò STAFF "Nhân viên": phân loại
-- công việc (để tự gán KPI) thuộc về nhóm nghiệp vụ, vai trò chỉ còn là cấp quyền.

-- Đổi mã dòng EDITOR thay vì tạo mới để tài khoản đang gán EDITOR tự sang STAFF, giữ nguyên quyền.
UPDATE "roles"
SET "code" = 'STAFF',
    "name" = 'Nhân viên',
    "description" = 'Tự nhập và xác nhận dữ liệu cá nhân'
WHERE "code" = 'EDITOR';

-- Tài khoản đang gán CONTENT_CREATOR chuyển sang STAFF cùng phạm vi.
INSERT INTO "user_roles" ("user_id", "role_id", "scope_type", "scope_team_id")
SELECT ur."user_id", staff."id", ur."scope_type", ur."scope_team_id"
FROM "user_roles" AS ur
JOIN "roles" AS cc ON cc."id" = ur."role_id" AND cc."code" = 'CONTENT_CREATOR'
CROSS JOIN "roles" AS staff
WHERE staff."code" = 'STAFF'
ON CONFLICT DO NOTHING;

UPDATE "employee_groups"
SET "default_role_id" = (SELECT "id" FROM "roles" WHERE "code" = 'STAFF')
WHERE "default_role_id" = (SELECT "id" FROM "roles" WHERE "code" = 'CONTENT_CREATOR');

-- user_roles và role_permissions của CONTENT_CREATOR xoá theo (ON DELETE CASCADE).
DELETE FROM "roles" WHERE "code" = 'CONTENT_CREATOR';
