CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'HR',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

INSERT INTO "User" VALUES ('user-admin','admin@vcbsalary.vn','$2b$10$cDmpAON2r4QCDWqs7VYKk.MXfXSNOCojotPg1RUFmWeBi3io6HS/G','Nguyễn Minh Anh','ADMIN','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z');
INSERT INTO "User" VALUES ('user-hr','hr@vcbsalary.vn','$2b$10$cDmpAON2r4QCDWqs7VYKk.MXfXSNOCojotPg1RUFmWeBi3io6HS/G','Trần Thị Hương','HR','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z');
