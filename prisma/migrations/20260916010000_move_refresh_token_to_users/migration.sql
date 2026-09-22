ALTER TABLE "users"
  ADD COLUMN "refresh_token_hash" TEXT,
  ADD COLUMN "refresh_token_expires_at" TIMESTAMPTZ;

-- Mô hình mới chỉ cho phép một refresh token trên mỗi user. Để không đăng xuất người dùng
-- đang có phiên hợp lệ, giữ lại token còn hạn mới nhất và bỏ các token cũ/revoked.
UPDATE "users" AS "u"
SET
  "refresh_token_hash" = "latest"."token_hash",
  "refresh_token_expires_at" = "latest"."expires_at"
FROM (
  SELECT DISTINCT ON ("user_id")
    "user_id",
    "token_hash",
    "expires_at"
  FROM "refresh_tokens"
  WHERE "revoked_at" IS NULL
    AND "expires_at" > CURRENT_TIMESTAMP
  ORDER BY "user_id", "created_at" DESC, "id" DESC
) AS "latest"
WHERE "u"."id" = "latest"."user_id";

CREATE UNIQUE INDEX "users_refresh_token_hash_key"
ON "users"("refresh_token_hash");

DROP TABLE "refresh_tokens";
